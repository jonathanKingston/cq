import { useCallback, useRef, useState } from "react";
import type { Selection } from "../types";

// Drag thresholds — adjust these to tune sensitivity.
export const HORIZONTAL_COMMIT_RATIO = 0.4;
export const VERTICAL_COMMIT_RATIO = 0.3;
export const BADGE_APPEAR_RATIO = 0.3;
export const MAX_ROTATION_DEG = 3;
export const SNAP_BACK_MS = 200;
export const FLY_OFF_MS = 300;

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

export interface UseCardDragResult {
  drag: DragState;
  handlers: PointerHandlers;
  flyOff: (action: Exclude<Selection, null>) => Promise<void>;
  snapBack: () => void;
}

type DragDebugPayload = {
  hypothesisId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: number;
};

function emitDragDebug(payload: Omit<DragDebugPayload, "timestamp">) {
  const entry: DragDebugPayload = { ...payload, timestamp: Date.now() };
  // #region agent log
  console.log("[card-drag-debug]", JSON.stringify(entry));
  // #endregion
  if (typeof window !== "undefined") {
    const debugWindow = window as Window & { __cardDragDebug?: DragDebugPayload[] };
    if (!debugWindow.__cardDragDebug) debugWindow.__cardDragDebug = [];
    debugWindow.__cardDragDebug.push(entry);
  }
}

function inferAction(offset: DragOffset): Selection {
  const absX = Math.abs(offset.x);
  const absY = Math.abs(offset.y);
  if (absX < 10 && absY < 10) return null;
  // Require clear dominant axis to avoid flicker on diagonal drags.
  if (absX >= absY * 1.5) {
    return offset.x > 0 ? "approve" : "reject";
  }
  if (absY >= absX * 1.5) {
    return "skip";
  }
  return null;
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
  // Drag progress is stored as state so it is only written from event handlers,
  // not computed by reading cardRef during render.
  const [dragProgress, setDragProgress] = useState(0);

  const startPos = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);

  const getThresholds = useCallback(() => {
    const el = cardRef.current;
    if (!el) return { horizontal: 150, vertical: 100 };
    return {
      horizontal: el.offsetWidth * HORIZONTAL_COMMIT_RATIO,
      vertical: el.offsetHeight * VERTICAL_COMMIT_RATIO,
    };
  }, [cardRef]);

  const computeProgress = useCallback(
    (off: DragOffset): number => {
      const action = inferAction(off);
      if (!action) return 0;
      const thresholds = getThresholds();
      if (action === "approve" || action === "reject") {
        return Math.min(Math.abs(off.x) / thresholds.horizontal, 1);
      }
      return Math.min(Math.abs(off.y) / thresholds.vertical, 1);
    },
    [getThresholds],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (flyingOffRef.current || disabled) return;
    pointerId.current = e.pointerId;
    startPos.current = { x: e.clientX, y: e.clientY };
    setIsDragging(true);
    // #region agent log
    emitDragDebug({
      hypothesisId: "C",
      location: "useCardDrag.ts:onPointerDown",
      message: "pointer-down captured",
      data: { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, disabled },
    });
    // #endregion
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [disabled]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startPos.current || e.pointerId !== pointerId.current) {
        // #region agent log
        emitDragDebug({
          hypothesisId: "C",
          location: "useCardDrag.ts:onPointerMove",
          message: "pointer-move ignored due to pointer mismatch or missing startPos",
          data: {
            hasStartPos: Boolean(startPos.current),
            eventPointerId: e.pointerId,
            trackedPointerId: pointerId.current,
          },
        });
        // #endregion
        return;
      }
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      const off = { x: dx, y: dy };
      const action = inferAction(off);
      const thresholds = getThresholds();
      const progress = computeProgress(off);
      setOffset(off);
      setDragProgress(progress);
      // #region agent log
      emitDragDebug({
        hypothesisId: "A_B",
        location: "useCardDrag.ts:onPointerMove",
        message: "pointer-move computed drag state",
        data: {
          offset: off,
          action,
          progress,
          thresholds,
          axisRatio: Math.abs(dx) > 0 ? Math.abs(dy) / Math.abs(dx) : null,
        },
      });
      // #endregion
    },
    [computeProgress, getThresholds],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;
      if (!startPos.current) return;
      const currentOffset = { x: e.clientX - startPos.current.x, y: e.clientY - startPos.current.y };
      const action = inferAction(currentOffset);
      const progress = computeProgress(currentOffset);

      startPos.current = null;
      pointerId.current = null;
      setIsDragging(false);
      // #region agent log
      emitDragDebug({
        hypothesisId: "D",
        location: "useCardDrag.ts:onPointerUp",
        message: "pointer-up final action decision",
        data: {
          currentOffset,
          action,
          progress,
          willCommit: Boolean(action && progress >= 1),
        },
      });
      // #endregion

      if (action && progress >= 1) {
        onCommit(action);
      } else {
        setOffset({ x: 0, y: 0 });
        setDragProgress(0);
      }
    },
    [computeProgress, onCommit],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;
      // #region agent log
      emitDragDebug({
        hypothesisId: "C",
        location: "useCardDrag.ts:onPointerCancel",
        message: "pointer-cancel resetting drag state",
        data: { pointerId: e.pointerId },
      });
      // #endregion
      startPos.current = null;
      pointerId.current = null;
      setIsDragging(false);
      setOffset({ x: 0, y: 0 });
      setDragProgress(0);
    },
    [],
  );

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
    setOffset({ x: 0, y: 0 });
    setDragProgress(0);
    setIsDragging(false);
    startPos.current = null;
    pointerId.current = null;
  }, [cardRef]);

  const dragAction = inferAction(offset);

  return {
    drag: { offset, isDragging, isFlyingOff, dragAction, dragProgress },
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    flyOff,
    snapBack,
  };
}
