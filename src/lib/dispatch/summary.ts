// Feature 07 AC-10: a packet keeps its history when items are removed. Pure (used by the document page and tests).

export type PacketItemState = { removedAt: string | null };

/** "1 of 3 removed" while some items are still in the packet; "Cancelled" when every item was removed; else null. */
export function packetSummary(items: PacketItemState[]): string | null {
  const removed = items.filter((i) => i.removedAt).length;
  if (!removed) return null;
  return removed === items.length ? "Cancelled" : `${removed} of ${items.length} removed`;
}
