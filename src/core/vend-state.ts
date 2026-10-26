export type VendState = 'QUEUED' | 'SENT' | 'ACKED' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

export const VEND_STATES: readonly VendState[] = ['QUEUED', 'SENT', 'ACKED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REFUNDED'];

/**
 * Legal transitions. Notes:
 *  - SENT -> SENT (resend) is NOT a transition; it only issues a new nonce for the same vend ID.
 *  - FAILED -> ACKED exists because a device may have vended and its acknowledgement arrived late.
 *  - CONFIRMED, CANCELLED and REFUNDED are terminal.
 */
export const TRANSITIONS: Readonly<Record<VendState, readonly VendState[]>> = {
  QUEUED: ['SENT', 'CANCELLED'],
  SENT: ['ACKED', 'FAILED', 'CANCELLED'],
  ACKED: ['CONFIRMED', 'FAILED'],
  FAILED: ['QUEUED', 'ACKED', 'REFUNDED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export class IllegalTransitionError extends Error {
  from: string;
  to: string;
  constructor(from: string, to: string) {
    super(`Illegal vend transition ${from} -> ${to}`);
    this.from = from; this.to = to;
  }
}

export function canTransition(from: VendState, to: VendState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: VendState, to: VendState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(s: VendState): boolean {
  return TRANSITIONS[s].length === 0;
}
