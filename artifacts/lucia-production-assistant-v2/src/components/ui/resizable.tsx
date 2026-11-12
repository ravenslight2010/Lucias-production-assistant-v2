'use client';

import * as React from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { cn } from '@/lib/utils';
import { GripVertical } from 'lucide-react';

type ResizableOrientation = React.ComponentProps<
  typeof ResizablePrimitive.Group
>['orientation'];

const ResizableOrientationContext =
  React.createContext<ResizableOrientation>('horizontal');

const ResizablePanelGroup = ({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>) => (
  <ResizableOrientationContext.Provider value={orientation}>
    <ResizablePrimitive.Group
      className={cn('h-full w-full', className)}
      orientation={orientation}
      {...props}
    />
  </ResizableOrientationContext.Provider>
);

const ResizablePanel = ResizablePrimitive.Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) => {
  const orientation = React.useContext(ResizableOrientationContext);
  const isVertical = orientation === 'vertical';

  return (
    <ResizablePrimitive.Separator
      className={cn(
        'relative flex items-center justify-center bg-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
        isVertical ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            'z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border',
            isVertical && 'rotate-90',
          )}
        >
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  );
};

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
