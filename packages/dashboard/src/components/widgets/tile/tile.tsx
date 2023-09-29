import React, { PropsWithChildren, SyntheticEvent, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import {
  colorBorderDividerDefault,
  borderRadiusBadge,
  colorBackgroundContainerContent,
  spaceScaledXxs,
  spaceScaledXs,
  spaceScaledM,
} from '@cloudscape-design/design-tokens';
import { CancelableEventHandler, ClickDetail } from '@cloudscape-design/components/internal/events';

import { DashboardWidget } from '~/types';
import { useDeleteWidgets } from '~/hooks/useDeleteWidgets';
import ConfirmDeleteModal from '~/components/confirmDeleteModal';
import { DashboardState } from '~/store/state';

import './tile.css';
import { onChangeDashboardGridEnabledAction } from '~/store/actions';
import { gestureable } from '~/components/internalDashboard/gestures/determineTargetGestures';

type DeletableTileActionProps = {
  handleDelete: CancelableEventHandler<ClickDetail>;
};

const DeletableTileAction = ({ handleDelete }: DeletableTileActionProps) => {
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  return (
    <div onMouseDown={handleMouseDown}>
      <Button onClick={handleDelete} ariaLabel='delete widget' variant='icon' iconName='close' />
    </div>
  );
};

export type WidgetTileProps = PropsWithChildren<{
  widget: DashboardWidget;
  title?: string;
  removeable?: boolean;
}>;

/**
 *
 * Component to add functionality to the widget container
 * Allows a user to title a widget, add click remove
 */
const WidgetTile: React.FC<WidgetTileProps> = ({ children, widget, title, removeable }) => {
  const isReadOnly = useSelector((state: DashboardState) => state.readOnly);
  const dispatch = useDispatch();
  const [visible, setVisible] = useState(false);
  const { onDelete } = useDeleteWidgets();

  const isRemoveable = !isReadOnly && removeable;
  const headerVisible = !isReadOnly || title;

  const disableGridMovement = (_event: SyntheticEvent) => {
    dispatch(onChangeDashboardGridEnabledAction({ enabled: false }));
  };

  const enableGridMovement = (_event: SyntheticEvent) => {
    dispatch(onChangeDashboardGridEnabledAction({ enabled: true }));
  };

  const handleDelete: CancelableEventHandler<ClickDetail> = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dispatch(onChangeDashboardGridEnabledAction({ enabled: false }));
    setVisible(true);
  };

  const handleCloseModal = () => {
    dispatch(onChangeDashboardGridEnabledAction({ enabled: true }));
    setVisible(false);
  };

  const handleSubmit = () => {
    onDelete(widget);
    dispatch(onChangeDashboardGridEnabledAction({ enabled: true }));
    setVisible(false);
  };

  return (
    <div
      role='widget'
      aria-description='widget tile'
      className='widget-tile'
      style={{
        border: `2px solid ${colorBorderDividerDefault}`,
        borderRadius: borderRadiusBadge,
        backgroundColor: colorBackgroundContainerContent,
      }}
    >
      {headerVisible && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: `${spaceScaledXs} ${spaceScaledXs} ${spaceScaledXxs} ${spaceScaledM}`,
            borderBottom: `2px solid ${colorBorderDividerDefault}`,
          }}
          {...gestureable('moveable')}
        >
          <Box variant='h1' fontSize='body-m'>
            {title}
          </Box>
          <SpaceBetween size='s' direction='horizontal'>
            {isRemoveable && <DeletableTileAction handleDelete={handleDelete} />}
            <ConfirmDeleteModal
              visible={visible}
              headerTitle='Delete selected widget?'
              cancelTitle='Cancel'
              submitTitle='Delete'
              description={
                <Box>
                  <Box variant='p'>
                    Are you sure you want to delete the selected widget? You'll lose all the progress you made to the
                    widget
                  </Box>
                  <Box variant='p' padding={{ top: 'm' }}>
                    You cannot undo this action.
                  </Box>
                </Box>
              }
              handleDismiss={handleCloseModal}
              handleCancel={handleCloseModal}
              handleSubmit={handleSubmit}
            />
          </SpaceBetween>
        </div>
      )}
      <div className='widget-tile-body' onPointerEnter={disableGridMovement} onPointerLeave={enableGridMovement}>
        {children}
      </div>
    </div>
  );
};

export default WidgetTile;