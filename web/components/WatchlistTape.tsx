"use client";

/**
 * The watchlist tape: one live chip plus static reference chips in a single
 * horizontal strip, reorderable by drag.
 *
 * This is the vertical WatchlistPanel refactored into the reference layout's
 * ticker tape: same domain (one live BTC-USD mid plus `simulated` reference
 * rows), same pure layer (`moveSymbol`, persistence, selection), new axis.
 * Drag is a dnd-kit horizontal sortable list: mouse drags start after 6px,
 * keyboard reorders via sortable coordinates, and touch needs a 250ms
 * long-press (plain swipes pan the strip via `touch-pan-x`).
 * Keyboard: Tab to a chip, Space to lift, arrow keys to move, Space to drop.
 * The whole chip stays the drag activator and the drag locks to the
 * horizontal axis, so a reorder never wobbles the strip's row.
 *
 * Selecting a temp chip parks the chart (the screen renders the placeholder
 * the caller puts in its place); selecting BTC-USD returns to the live chart.
 * Presentational like the other panels: order, selection, and the live price
 * in, two callbacks out.
 */

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";

import { Panel } from "@/components/Panel";
import { isTempSymbol, tempRefPrice } from "@/lib/watchlist";

type WatchlistTapeProps = {
  /** Chip order, live or temp symbols. */
  order: readonly string[];
  /** The symbol the screen is following (chart live vs parked). */
  selected: string;
  /** BTC mid formatted with 2 decimals, or null before the first frame. */
  livePrice: string | null;
  /** Follow a chip: BTC-USD unparks the chart, a temp chip parks it. */
  onSelect: (symbol: string) => void;
  /** Move the chip at `from` to `to` after a drop. */
  onReorder: (from: number, to: number) => void;
};

function TapeChip({
  symbol,
  selected,
  livePrice,
  dropTarget,
  onSelect,
}: {
  symbol: string;
  selected: boolean;
  livePrice: string | null;
  /** True while another chip hovers this position mid-drag. */
  dropTarget: boolean;
  onSelect: (symbol: string) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: symbol,
  });
  const live = !isTempSymbol(symbol);
  const ref = tempRefPrice(symbol);

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-watchlist-chip={symbol}
      aria-pressed={selected}
      onClick={() => onSelect(symbol)}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...listeners}
      className={`flex shrink-0 cursor-grab items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[12px] touch-pan-x select-none transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-line active:cursor-grabbing ${
        dropTarget ? "border-ink" : "border-line/70"
      } ${isDragging ? "opacity-40" : ""} ${
        selected ? "bg-line/60 text-ink" : "bg-panel text-muted hover:text-ink"
      }`}
    >
      <span aria-hidden title="Drag to reorder" className="text-faint">
        <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true" className="shrink-0">
          <circle cx="2" cy="2.5" r="1.2" />
          <circle cx="6" cy="2.5" r="1.2" />
          <circle cx="2" cy="7" r="1.2" />
          <circle cx="6" cy="7" r="1.2" />
          <circle cx="2" cy="11.5" r="1.2" />
          <circle cx="6" cy="11.5" r="1.2" />
        </svg>
      </span>
      <span className="font-semibold">{symbol}</span>
      {live ? (
        <span className={`font-medium ${selected ? "text-ink-dim" : "text-faint"}`}>
          {livePrice ?? "—"}
        </span>
      ) : (
        <span className="font-medium text-faint">
          {ref ?? "—"} <span className="text-[10px] uppercase">sim</span>
        </span>
      )}
    </button>
  );
}

export function WatchlistTape({ order, selected, livePrice, onSelect, onReorder }: WatchlistTapeProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** The tape is one horizontal strip: kill vertical drift mid-drag. */
  const lockHorizontal: Modifier = ({ transform }) => ({ ...transform, y: 0 });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const endDrag = (): void => {
    setActiveId(null);
    setOverId(null);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    endDrag();
    if (over === null || active.id === over.id) {
      return;
    }
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from === -1 || to === -1) {
      return;
    }
    onReorder(from, to);
  };

  const handleDragOver = (event: DragOverEvent): void => {
    setOverId(event.over === null ? null : String(event.over.id));
  };

  return (
    <Panel
      title="Watchlist"
      hint="drag to reorder · Tab + Space works too · click to follow"
      className="h-full"
      bodyClassName="flex flex-1 flex-col justify-center"
    >
      <DndContext
      sensors={sensors}
      modifiers={[lockHorizontal]}
      collisionDetection={closestCenter}
      onDragStart={(event) => setActiveId(String(event.active.id))}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
    >
      <SortableContext items={[...order]} strategy={horizontalListSortingStrategy}>
        <div
          role="toolbar"
          aria-label="Watchlist symbols"
          className="flex min-w-0 items-center gap-2 overflow-x-auto"
        >
          {order.map((symbol) => (
            <TapeChip
              key={symbol}
              symbol={symbol}
              selected={symbol === selected}
              livePrice={livePrice}
              dropTarget={overId !== null && overId === symbol && activeId !== symbol}
              onSelect={onSelect}
            />
          ))}
        </div>
      </SortableContext>
      </DndContext>
    </Panel>
  );
}
