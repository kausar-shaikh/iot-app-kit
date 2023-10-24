import {
  CreateWorkspaceCommandOutput,
  GetWorkspaceCommandOutput,
  ResourceNotFoundException,
  ValidationException,
} from '@aws-sdk/client-iottwinmaker';
import { delay, replaceTemplateVars, regionToAirportCode } from './utils';
import { getDefaultAwsClients as aws } from './aws-clients';
import { WORKSPACE_ROLE_ASSUME_POLICY } from './policy/workspace-role-assume-policy';
import { WORKSPACE_DASHBOARD_ROLE_ASSUME_POLICY } from './policy/workspace-dashboard-role-assume-policy';
import { workspaceRolePolicyTemplate } from './policy/workspace-role-policy';
import { workspaceDashboardRolePolicyTemplate } from './policy/workspace-dashboard-role-policy';
import { CreatePolicyCommandOutput, CreateRoleCommandOutput } from '@aws-sdk/client-iam';
import {
  CreateBucketCommandOutput,
  CreateBucketRequest,
  GetBucketLoggingCommandOutput,
  ListObjectVersionsCommandOutput,
  ListObjectsV2CommandOutput,
  NoSuchBucket,
} from '@aws-sdk/client-s3';

/**
 * Helper function during workspace creation to create and attach roles and policies
 * @param workspaceId workspaceId used as part identifier for the role and policy
 * @param accountId accountId used as part identifier for the role and policy
 * @param region region used as part identifier for the role and policy
 * @param roleType Role or DashboardRole
 * @param roleAssumePolicy stringified JSON of the policy
 * @param rolePolicy stringified JSON of the role
 * @returns promise of the roleArn
 */
async function createRoleAndPolicy(
  workspaceId: string,
  accountId: string,
  region: string,
  roleType: 'WorkspaceRole' | 'WorkspaceDashboardRole',
  roleAssumePolicy: string,
  rolePolicy: string
) {
  let roleName;
  let policyName;
  if (roleType === 'WorkspaceRole') {
    roleName = `twinmaker-workspace-${workspaceId}-${accountId}-${region}`.toLowerCase();
    policyName = `twinmaker-workspace-${workspaceId}-${accountId}-${region}-AutoPolicy`.toLowerCase();
  } else if (roleType === 'WorkspaceDashboardRole') {
    roleName = `twinmaker-${roleType}-${workspaceId}-${accountId}-${region}`.toLowerCase();
    policyName = `twinmaker-${roleType}-${workspaceId}-${accountId}-${region}-AutoPolicy`.toLowerCase();
  }
  console.log(`Creating Role ${roleName}...`);
  const createRoleResponse: CreateRoleCommandOutput = await aws().iam.createRole({
    RoleName: roleName,
    Path: '/',
    AssumeRolePolicyDocument: roleAssumePolicy,
    Description: `${roleType} generated by AWS IoT TwinMaker TMDT`,
  });
  if (!createRoleResponse.Role || !createRoleResponse.Role.Arn) {
    throw new Error(`Failed to create role ${roleName}.`);
  }
  const roleArn: string = createRoleResponse.Role.Arn;
  console.log(`Created Role: ${roleArn}.`);

  const createPolicyResponse: CreatePolicyCommandOutput = await aws().iam.createPolicy({
    PolicyName: policyName,
    PolicyDocument: rolePolicy,
    Description: `${roleType} Policy generated by AWS IoT TwinMaker TMDT`,
  });
  if (!createPolicyResponse.Policy || !createPolicyResponse.Policy.Arn) {
    throw new Error(`Failed to create policy for role ${roleArn}.`);
  }
  const policyArn: string | undefined = createPolicyResponse.Policy.Arn;
  console.log(`Created Policy: ${policyArn}`);

  await aws().iam.attachRolePolicy({
    RoleName: roleName,
    PolicyArn: policyArn,
  });
  console.log(`Attached Policy: ${policyArn} to Role: ${roleArn}.`);
  return roleArn;
}
/**
 * Helper function for creating s3 Buckets with versioning, policies, access block, and public encryption
 * @param s3BucketName Bucket name
 * @param region workspace region
 */
async function createS3Bucket(s3BucketName: string, region: string): Promise<void> {
  const params: CreateBucketRequest = {
    Bucket: s3BucketName,
  };
  /**
   * @see https://stackoverflow.com/questions/51912072/invalidlocationconstraint-error-while-creating-s3-bucket-when-the-used-command-i
   *
   * tl;dr - `us-east-1` is considered a special default region so LocationConstraint is
   *  not required/accepted
   */
  if (region !== 'us-east-1') {
    params.CreateBucketConfiguration = {
      LocationConstraint: region,
    };
  }
  const createBucketResponse: CreateBucketCommandOutput = await aws().s3.createBucket(params);
  await aws().s3.putBucketVersioning({
    Bucket: s3BucketName,
    VersioningConfiguration: {
      Status: 'Enabled',
    },
  });
  const s3BucketPolicy = {
    Statement: [
      {
        Action: 's3:*',
        Effect: 'Deny',
        Principal: '*',
        Resource: [`arn:aws:s3:::${s3BucketName}`, `arn:aws:s3:::${s3BucketName}/*`],
        Condition: {
          Bool: { 'aws:SecureTransport': false },
        },
      },
    ],
  };
  await aws().s3.putBucketPolicy({
    Bucket: s3BucketName,
    Policy: JSON.stringify(s3BucketPolicy),
  });
  await aws().s3.putPublicAccessBlock({
    Bucket: s3BucketName,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  await aws().s3.putBucketEncryption({
    Bucket: s3BucketName,
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256',
          },
        },
      ],
    },
  });
  console.log(`S3 Bucket created: ${createBucketResponse.Location}`);
}

// Enable access logging for the source bucket and save logs in the target bucket
const enableAccessLogging = async (sourceBucketName: string, targetBucketName: string): Promise<boolean> => {
  try {
    // Step 1 - Grant Log Delivery group permission to write log to the target bucket
    await grantPermissionsToWriteLogs(targetBucketName);
    // Step 2 - Enable logging on the source bucket
    await putBucketLogging(sourceBucketName, targetBucketName);
  } catch (error) {
    return false;
  }
  return true;
};

// Grant Log Delivery group permission to write log to the target bucket
const grantPermissionsToWriteLogs = async (bucketName: string): Promise<boolean> => {
  try {
    await aws().s3.putBucketAcl({
      Bucket: bucketName,
      GrantReadACP: 'URI=http://acs.amazonaws.com/groups/s3/LogDelivery',
      GrantWrite: 'URI=http://acs.amazonaws.com/groups/s3/LogDelivery',
    });
  } catch (error) {
    return false;
  }
  return true;
};

// Enable logging on the source bucket
const putBucketLogging = async (sourceBucketName: string, targetBucketName: string): Promise<boolean> => {
  try {
    await aws().s3.putBucketLogging({
      Bucket: sourceBucketName,
      BucketLoggingStatus: {
        LoggingEnabled: {
          TargetBucket: targetBucketName,
          TargetPrefix: 'logs/',
        },
      },
    });
  } catch (error) {
    return false;
  }
  return true;
};

/**
 * Helper function during workspace creation to create workspace S3 bucket, configure CORS policy, and enable bucket logging
 * @param workspaceId workspaceId used as part identifier for the bucket name
 * @param accountId accountId used as part identifier for the bucket name
 * @param region region used as part identifier for the bucket name
 * @returns promise of the S3 bucket name and arn
 */
async function createWorkspaceS3Bucket(workspaceId: string, accountId: string, region: string) {
  const s3BucketName = `twinmaker-workspace-${workspaceId}-${accountId}-${regionToAirportCode(region)}`.toLowerCase();
  console.log(`Creating S3 Bucket for the TwinMaker Workspace in region: ${region}...`);
  await createS3Bucket(s3BucketName, region);
  console.log('Configuring CORS Policy...');
  await aws().s3.putBucketCors({
    Bucket: s3BucketName,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ['*'],
          AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
          AllowedOrigins: ['*'],
          ExposeHeaders: ['ETag'],
        },
      ],
    },
  });
  console.log('CORS Policy configured');
  console.log('Creating bucket for access logging...');
  const s3LoggingBucketName = `${s3BucketName}-logs`;
  await createS3Bucket(s3LoggingBucketName, region);
  console.log('Enabling access logging for workspace S3 Bucket...');
  await enableAccessLogging(s3BucketName, s3LoggingBucketName);
  console.log('Access logging enabled.');
  return { s3BucketName, s3BucketArn: `arn:aws:s3:::${s3BucketName}` };
}

/**
 * Helper function to retry workspace creation during role propagation
 * @param workspaceId workspaceId
 * @param workspaceRoleArn newly created workspace role arn
 * @param s3BucketArn newly created workspace s3 bucket arn
 * @param attempts number of attempts to retry
 * @returns promise of the workspace arn if successfully created
 */
async function retryWorkspaceCreation(
  workspaceId: string,
  workspaceRoleArn: string,
  s3BucketArn: string,
  attempts: number
) {
  while (attempts > 0) {
    try {
      attempts--;
      const createWorkspaceResponse: CreateWorkspaceCommandOutput = await aws().tm.createWorkspace({
        workspaceId,
        role: workspaceRoleArn,
        s3Location: s3BucketArn,
      });
      const workspaceArn: string | undefined = createWorkspaceResponse.arn;
      if (!workspaceArn) {
        throw new Error('Failed to create Workspace');
      }
      console.log(`Created Workspace: ${workspaceArn}`);
      return workspaceArn;
    } catch (err) {
      if (
        (err instanceof ValidationException && err.message.includes('Could not assume the role provided')) ||
        (err instanceof ValidationException && err.message.includes('Could not access S3 with the role provided'))
      ) {
        console.log('Waiting for the newly created role to be propagated...');
        await delay(2000);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Retry exhausted');
}

/**
 * Driver function for workspace creation
 * @param workspaceId workspace-id to be created
 * @returns promise of workspace arn, s3 arn, role arn, dashboardrole arn
 */
async function prepareWorkspace(workspaceId: string) {
  const region: string = aws().region;
  const { accountId, accountArn } = await aws().getCurrentIdentity();
  const { s3BucketArn } = await createWorkspaceS3Bucket(workspaceId, accountId, region);

  const policyParams: Record<string, string> = {
    accountId,
    accountArn,
    region,
    workspaceId,
    workspaceS3BucketArn: s3BucketArn,
  };

  const workspaceRolePolicy: string = replaceTemplateVars(JSON.stringify(workspaceRolePolicyTemplate), policyParams);

  const workspaceRoleArn: string = await createRoleAndPolicy(
    workspaceId,
    accountId,
    regionToAirportCode(region),
    'WorkspaceRole',
    JSON.stringify(WORKSPACE_ROLE_ASSUME_POLICY),
    workspaceRolePolicy
  );
  // retry workspace creation up to 10 times to allow role to propagate
  const workspaceArn: string = await retryWorkspaceCreation(workspaceId, workspaceRoleArn, s3BucketArn, 10);

  policyParams.workspaceArn = workspaceArn;
  policyParams.dashboardRoleAssumedByArn = accountArn;
  const workspaceDashboardRoleAssumePolicy: string = replaceTemplateVars(
    JSON.stringify(WORKSPACE_DASHBOARD_ROLE_ASSUME_POLICY),
    policyParams
  );
  const workspaceDashboardRolePolicy: string = replaceTemplateVars(
    JSON.stringify(workspaceDashboardRolePolicyTemplate),
    policyParams
  );
  console.log(
    '\nWARNING: Dashboard role policy will be created without video permissions. Please either edit the policy in IAM or create workspace in console to self-define any additional permissions.\n'
  );
  const workspaceDashboardRoleArn: string = await createRoleAndPolicy(
    workspaceId,
    accountId,
    regionToAirportCode(region),
    'WorkspaceDashboardRole',
    workspaceDashboardRoleAssumePolicy,
    workspaceDashboardRolePolicy
  );

  return {
    workspaceArn,
    workspaceS3BucketArn: s3BucketArn,
    workspaceRoleArn,
    workspaceDashboardRoleArn,
  };
}

/**
 * Create a workspace if it does not already exist
 * @param workspaceId workspace-id to be created
 * @returns promise of workspace id and arn if created successfully
 */
async function createWorkspaceIfNotExists(workspaceId: string) {
  let workspace: GetWorkspaceCommandOutput;
  console.log(`Creating a new Workspace: ${workspaceId}`);
  try {
    workspace = await aws().tm.getWorkspace({ workspaceId });
    console.log(`Found an existing Workspace with the same Id. Skip creating Workspace.`);
  } catch (e) {
    if (e instanceof ResourceNotFoundException) {
      await prepareWorkspace(workspaceId);
      workspace = await aws().tm.getWorkspace({ workspaceId });
    } else {
      throw new Error(`Failed to get workspace. ${e}`);
    }
  }
  if (!workspace.workspaceId) {
    throw new Error('Unable to get a valid workspace');
  }
  return {
    workspaceId,
    workspaceArn: workspace.arn,
  };
}
/**
 * Deletes specifified bucket, objects, and any logging bucket if applicable
 * @param s3BucketName S3 bucket name
 */
async function deleteWorkspaceBucketAndLogs(s3BucketName: string | undefined, nonDryRun: boolean): Promise<void> {
  // delete logging bucket if it exists
  try {
    const bucketLoggingResp: GetBucketLoggingCommandOutput = await aws().s3.getBucketLogging({ Bucket: s3BucketName });
    if (bucketLoggingResp.LoggingEnabled != undefined) {
      console.log('Deleting logging bucket...');
      await deleteS3Bucket(`${bucketLoggingResp.LoggingEnabled.TargetBucket}`, nonDryRun);
    }
  } catch (e) {
    // getBucketLogging does not return a NoSuchBucket instance; instead manually check the message
    if (e instanceof Error && e.message.includes('The specified bucket does not exist')) {
      console.log('Logging Bucket not found, moving on with deletion.');
    } else {
      throw e;
    }
  }
  try {
    console.log('Deleting workspace bucket...');
    await deleteS3Bucket(s3BucketName, nonDryRun);
  } catch (e) {
    if (e instanceof NoSuchBucket) {
      console.log(`Bucket does not exist and cannot be deleted: ${s3BucketName}`);
    } else {
      throw e;
    }
  }
}

/**
 * Deletes a role and any associated policies following the steps outlined here:
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_manage_delete.html#roles-managingrole-deleting-cli
 * @param roleName role name
 */
async function deleteIAMroleAndPolicy(roleName: string | undefined): Promise<void> {
  // Step 1: Remove the role from all instance profiles that the role is associated with
  const instanceProfileResp = await aws().iam.listInstanceProfilesForRole({ RoleName: roleName });
  if (instanceProfileResp.InstanceProfiles != undefined) {
    for (const instanceProfile of instanceProfileResp.InstanceProfiles) {
      await aws().iam.removeRoleFromInstanceProfile({
        RoleName: roleName,
        InstanceProfileName: instanceProfile.InstanceProfileName,
      });
      console.log(`removed role from instance profile: ${instanceProfile.InstanceProfileName}`);
    }
  }
  // Step 2: Delete all policies that are associated with the role
  const rolePolicies = await aws().iam.listRolePolicies({ RoleName: roleName });
  if (rolePolicies.PolicyNames != undefined) {
    for (const policy of rolePolicies.PolicyNames) {
      await aws().iam.deleteRolePolicy({ RoleName: roleName, PolicyName: policy });
      console.log(`deleted policy: ${policy}`);
    }
  }
  const attachedRolePolicies = await aws().iam.listAttachedRolePolicies({ RoleName: roleName });
  if (attachedRolePolicies.AttachedPolicies != undefined) {
    for (const attachedPolicy of attachedRolePolicies.AttachedPolicies) {
      await aws().iam.detachRolePolicy({ RoleName: roleName, PolicyArn: attachedPolicy.PolicyArn });
      await aws().iam.deletePolicy({ PolicyArn: attachedPolicy.PolicyArn });
      console.log(`detached and deleted policy: ${attachedPolicy.PolicyName}`);
    }
  }
  // Step 3: Delete role
  await aws().iam.deleteRole({ RoleName: roleName });
  console.log(`deleted role: ${roleName}`);
}

/**
 * Deletes a specified TwinMaker workspace
 * @param workspaceId TM workspaceID
 * @returns DeleteWorkspaceCommandOutput if successful
 */
async function deleteWorkspace(workspaceId: string, nonDryRun: boolean): Promise<void> {
  try {
    if (nonDryRun) {
      await aws().tm.deleteWorkspace({ workspaceId });
    }
    console.log(`deleted workspace: ${workspaceId}`);
  } catch (err) {
    console.log(`Unable to delete workspace ${workspaceId}:\n ${err}`);
    throw err;
  }
}

/**
 * Helper function that deletes all objects in a specified bucket, any potential object versions, and the bucket itself
 * @param s3BucketName S3 bucket name
 */
async function deleteS3Bucket(s3BucketName: string | undefined, nonDryRun: boolean) {
  let isTruncated: boolean | undefined = true;
  let NextContinuationToken;
  // Delete all objects in bucket
  while (isTruncated) {
    const listObjectsResp: ListObjectsV2CommandOutput = await aws().s3.listObjectsV2({
      Bucket: s3BucketName,
      ContinuationToken: NextContinuationToken,
    });
    isTruncated = listObjectsResp.IsTruncated;
    NextContinuationToken = listObjectsResp.NextContinuationToken;
    if (listObjectsResp.Contents != undefined) {
      for (const obj of listObjectsResp.Contents) {
        if (nonDryRun) {
          await aws().s3.deleteObject({ Bucket: s3BucketName, Key: obj['Key'] });
        }
        console.log(`deleted S3 Object: ${obj['Key']}`);
      }
    }
  }
  // Delete all versions in bucket if bucket has versioning
  isTruncated = true;
  let NextVersionIdMarker;
  let NextKeyMarker;
  while (isTruncated) {
    const listObjectVersionResp: ListObjectVersionsCommandOutput = await aws().s3.listObjectVersions({
      Bucket: s3BucketName,
      VersionIdMarker: NextVersionIdMarker,
      KeyMarker: NextKeyMarker,
    });
    NextVersionIdMarker = listObjectVersionResp.NextVersionIdMarker;
    NextKeyMarker = listObjectVersionResp.NextKeyMarker;
    isTruncated = listObjectVersionResp.IsTruncated;
    if (listObjectVersionResp.Versions != undefined) {
      for (const version of listObjectVersionResp.Versions) {
        if (nonDryRun) {
          await aws().s3.deleteObject({ Bucket: s3BucketName, Key: version['Key'], VersionId: version['VersionId'] });
        }
        console.log(`deleted S3 Object: ${version['Key']}, version: ${version['VersionId']}`);
      }
    }
    if (listObjectVersionResp.DeleteMarkers != undefined) {
      for (const version of listObjectVersionResp.DeleteMarkers) {
        if (nonDryRun) {
          await aws().s3.deleteObject({ Bucket: s3BucketName, Key: version['Key'], VersionId: version['VersionId'] });
        }
        console.log(`deleted S3 delete marker: ${version['Key']}, version: ${version['VersionId']}`);
      }
    }
  }
  // Delete bucket
  if (nonDryRun) {
    await aws().s3.deleteBucket({ Bucket: s3BucketName });
  }
  console.log(`\ndeleted S3 Bucket: ${s3BucketName}`);
}

export { createWorkspaceIfNotExists, deleteWorkspaceBucketAndLogs, deleteWorkspace, deleteIAMroleAndPolicy };
