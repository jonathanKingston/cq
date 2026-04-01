import { useCallback, useRef, useState } from "react";
import type { Selection } from "../types";

// Drag thresholds — adjust these to tune sensitivity.
export const HORIZONTAL_COMMIT_RATIO = 0.4;
export const VERTICAL_COMMIT_RATIO = 0.3;
export const BADGE_APPEAR_RATIO = 0.3;
export const MAX_ROTATION_DEG = 3;
export const SNAP_BACK_MS = 200;
export const FLY_OFF_MS = 300;
export const GESTURE_SLOP_PX = 10;
export const AXIS_DOMINANCE_RATIO = 1.5;
type DragAxis = "horizontal" | "vertical";

export interface DragOffset {
  x: number;
  y: number;
}

export interface DragState {
  offset: DragOffset;
  isDragging: boolean;
  isFlyingOff: boolean;
  dragAction: Selection;
  dragProgress: number;
}

export interface PointerHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

export interface TouchHandlers {
  onTouchStartCapture: (e: React.TouchEvent) => void;
  onTouchMoveCapture: (e: React.TouchEvent) => void;
  onTouchEndCapture: (e: React.TouchEvent) => void;
  onTouchCancelCapture: (e: React.TouchEvent) => void;
}

export type GestureHandlers = PointerHandlers & TouchHandlers;

export interface UseCardDragResult {
  drag: DragState;
  handlers: GestureHandlers;
  flyOff: (action: Exclude<Selection, null>) => Promise<void>;
  snapBack: () => void;
}

function startedInScrollRegion(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? target.closest("[data-scroll-region='true']") !== null
    : false;
}

function inferAction(offset: DragOffset): Selection {
  const absX = Math.abs(offset.x);
  const absY = Math.abs(offset.y);
  if (absX < GESTURE_SLOP_PX && absY < GESTURE_SLOP_PX) return null;
  // Require clear dominant axis to avoid flicker on diagonal drags.
  if (absX >= absY * AXIS_DOMINANCE_RATIO) {
    return offset.x > 0 ? "approve" : "reject";
  }
  if (absY >= absX * AXIS_DOMINANCE_RATIO) {
    return "skip";
  }
  return null;
}

function inferAxis(offset: DragOffset): DragAxis | null {
  const absX = Math.abs(offset.x);
  const absY = Math.abs(offset.y);
  if (absX < GESTURE_SLOP_PX && absY < GESTURE_SLOP_PX) return null;
  if (absX >= absY * AXIS_DOMINANCE_RATIO) return "horizontal";
  if (absY >= absX * AXIS_DOMINANCE_RATIO) return "vertical";
  return null;
}

function inferActionFromAxis(
  offset: DragOffset,
  axis: DragAxis | null,
): Selection {
  if (!axis) return inferAction(offset);
  if (axis === "vertical") {
    return Math.abs(offset.y) >= GESTURE_SLOP_PX ? "skip" : null;
  }
  if (Math.abs(offset.x) < GESTURE_SLOP_PX) return null;
  return offset.x > 0 ? "approve" : "reject";
}

function constrainOffsetToAxis(
  offset: DragOffset,
  axis: DragAxis,
): DragOffset {
  return axis === "vertical"
    ? { x: 0, y: offset.y }
    : { x: offset.x, y: 0 };
}

function resetDragState(
  setOffset: (offset: DragOffset) => void,
  setDragProgress: (progress: number) => void,
  setIsDragging: (dragging: boolean) => void,
  setDragAxis: (axis: DragAxis | null) => void,
  startPos: React.RefObject<{ x: number; y: number } | null>,
  pointerId: React.RefObject<number | null>,
  dragStartTarget: React.RefObject<EventTarget | null>,
  lockedAxis: React.RefObject<DragAxis | null>,
) {
  startPos.current = null;
  pointerId.current = null;
  dragStartTarget.current = null;
  lockedAxis.current = null;
  setIsDragging(false);
  setDragAxis(null);
  setOffset({ x: 0, y: 0 });
  setDragProgress(0);
}

export function useCardDrag(
  cardRef: React.RefObject<HTMLDivElement | null>,
  onCommit: (action: Exclude<Selection, null>) => void,
  disabled = false,
): UseCardDragResult {
  const [offset, setOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isFlyingOff, setIsFlyingOff] = useState(false);
  const flyingOffRef = useRef(false);
  const [dragAxis, setDragAxis] = useState<DragAxis | null>(null);
  // Drag progress is stored as state so it is only written from event handlers,
  // not computed by reading cardRef during render.
  const [dragProgress, setDragProgress] = useState(0);

  const startPos = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);
  const dragStartTarget = useRef<EventTarget | null>(null);
  const lockedAxis = useRef<DragAxis | null>(null);

  const getThresholds = useCallback(() => {
    const el = cardRef.current;
    if (!el) return { horizontal: 150, vertical: 100 };
    return {
      horizontal: el.offsetWidth * HORIZONTAL_COMMIT_RATIO,
      vertical: el.offsetHeight * VERTICAL_COMMIT_RATIO,
    };
  }, [cardRef]);

  const computeProgress = useCallback(
    (off: DragOffset, axis: DragAxis | null = null): number => {
      const resolvedAxis = axis ?? inferAxis(off);
      if (!resolvedAxis) return 0;
      const thresholds = getThresholds();
      if (resolvedAxis === "horizontal") {
        return Math.min(Math.abs(off.x) / thresholds.horizontal, 1);
      }
      return Math.min(Math.abs(off.y) / thresholds.vertical, 1);
    },
    [getThresholds],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (flyingOffRef.current || disabled) return;
    if (e.pointerType === "touch") return;
    pointerId.current = e.pointerId;
    startPos.current = { x: e.clientX, y: e.clientY };
    dragStartTarget.current = e.target;
    lockedAxis.current = null;
    setDragAxis(null);
  }, [disabled]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (!startPos.current || e.pointerId !== pointerId.current) return;
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      const off = { x: dx, y: dy };
      const axis = inferAxis(off);

      if (!isDragging) {
        if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) {
          return;
        }

        // When a gesture starts inside the scrollable body, keep vertical motion
        // reserved for native scrolling and only lock into card drag on a clear
        // horizontal swipe.
        if (startedInScrollRegion(dragStartTarget.current) && axis === "vertical") {
          resetDragState(
            setOffset,
            setDragProgress,
            setIsDragging,
            setDragAxis,
            startPos,
            pointerId,
            dragStartTarget,
            lockedAxis,
          );
          return;
        }

        if (!axis) {
          return;
        }

        lockedAxis.current = axis;
        setDragAxis(axis);
        setIsDragging(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }

      const activeAxis = lockedAxis.current;
      if (!activeAxis) {
        return;
      }

      const constrainedOffset = constrainOffsetToAxis(off, activeAxis);
      setOffset(constrainedOffset);
      setDragProgress(computeProgress(constrainedOffset, activeAxis));
    },
    [computeProgress, isDragging],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (e.pointerId !== pointerId.current) return;
      if (!startPos.current) return;
      const rawOffset = { x: e.clientX - startPos.current.x, y: e.clientY - startPos.current.y };
      const axis = lockedAxis.current;
      const currentOffset = axis ? constrainOffsetToAxis(rawOffset, axis) : rawOffset;
      const action = inferActionFromAxis(currentOffset, axis);
      const progress = axis ? computeProgress(currentOffset, axis) : 0;

      if (action && progress >= 1) {
        startPos.current = null;
        pointerId.current = null;
        dragStartTarget.current = null;
        lockedAxis.current = null;
        setIsDragging(false);
        setDragAxis(null);
        onCommit(action);
      } else {
        resetDragState(
          setOffset,
          setDragProgress,
          setIsDragging,
          setDragAxis,
          startPos,
          pointerId,
          dragStartTarget,
          lockedAxis,
        );
      }
    },
    [computeProgress, onCommit],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (e.pointerId !== pointerId.current) return;
      resetDragState(
        setOffset,
        setDragProgress,
        setIsDragging,
        setDragAxis,
        startPos,
        pointerId,
        dragStartTarget,
        lockedAxis,
      );
    },
    [],
  );

  const onTouchStartCapture = useCallback((e: React.TouchEvent) => {
    if (flyingOffRef.current || disabled) return;
    const touch = e.touches[0];
    if (!touch) return;
    startPos.current = { x: touch.clientX, y: touch.clientY };
    dragStartTarget.current = e.target;
    lockedAxis.current = null;
    setDragAxis(null);
  }, [disabled]);

  const onTouchMoveCapture = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startPos.current.x;
      const dy = touch.clientY - startPos.current.y;
      const off = { x: dx, y: dy };
      const axis = inferAxis(off);

      if (!isDragging) {
        if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) {
          return;
        }

        if (startedInScrollRegion(dragStartTarget.current) && axis === "vertical") {
          startPos.current = null;
          dragStartTarget.current = null;
          lockedAxis.current = null;
          setDragAxis(null);
          return;
        }

        if (!axis) {
          return;
        }

        lockedAxis.current = axis;
        setDragAxis(axis);
        setIsDragging(true);
      }

      const activeAxis = lockedAxis.current;
      if (!activeAxis) {
        return;
      }

      e.preventDefault();
      const constrainedOffset = constrainOffsetToAxis(off, activeAxis);
      setOffset(constrainedOffset);
      setDragProgress(computeProgress(constrainedOffset, activeAxis));
    },
    [computeProgress, isDragging],
  );

  const onTouchEndCapture = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current) {
        dragStartTarget.current = null;
        lockedAxis.current = null;
        setDragAxis(null);
        return;
      }

      const touch = e.changedTouches[0];
      const axis = lockedAxis.current;
      const rawOffset = touch
        ? {
            x: touch.clientX - startPos.current.x,
            y: touch.clientY - startPos.current.y,
          }
        : offset;
      const currentOffset = axis ? constrainOffsetToAxis(rawOffset, axis) : rawOffset;
      const action = inferActionFromAxis(currentOffset, axis);
      const progress = axis ? computeProgress(currentOffset, axis) : 0;

      if (action && progress >= 1) {
        startPos.current = null;
        dragStartTarget.current = null;
        lockedAxis.current = null;
        setIsDragging(false);
        setDragAxis(null);
        onCommit(action);
      } else {
        resetDragState(
          setOffset,
          setDragProgress,
          setIsDragging,
          setDragAxis,
          startPos,
          pointerId,
          dragStartTarget,
          lockedAxis,
        );
      }
    },
    [computeProgress, offset, onCommit],
  );

  const onTouchCancelCapture = useCallback(() => {
    resetDragState(
      setOffset,
      setDragProgress,
      setIsDragging,
      setDragAxis,
      startPos,
      pointerId,
      dragStartTarget,
      lockedAxis,
    );
  }, []);

  const flyOff = useCallback(
    async (action: Exclude<Selection, null>) => {
      flyingOffRef.current = true;
      setIsFlyingOff(true);
      if (action === "skip") {
        setOffset({ x: 0, y: -window.innerHeight });
      } else {
        const distance = action === "approve" ? window.innerWidth : -window.innerWidth;
        setOffset({ x: distance, y: 0 });
      }
      await new Promise((resolve) => setTimeout(resolve, FLY_OFF_MS));
      setOffset({ x: 0, y: 0 });
      flyingOffRef.current = false;
      setIsFlyingOff(false);
    },
    [],
  );

  const snapBack = useCallback(() => {
    if (pointerId.current !== null) {
      cardRef.current?.releasePointerCapture(pointerId.current);
    }
    resetDragState(
      setOffset,
      setDragProgress,
      setIsDragging,
      setDragAxis,
      startPos,
      pointerId,
      dragStartTarget,
      lockedAxis,
    );
  }, [cardRef]);

  const dragAction = inferActionFromAxis(offset, dragAxis);

  return {
    drag: { offset, isDragging, isFlyingOff, dragAction, dragProgress },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onTouchStartCapture,
      onTouchMoveCapture,
      onTouchEndCapture,
      onTouchCancelCapture,
    },
    flyOff,
    snapBack,
  };
}
