/**
 * message-waiter.ts — Turn-based idle/wake primitive for agent teams.
 *
 * Each idle teammate registers a MessageWaiter. When a message arrives via
 * sendMessage(), the waiter is resolved, waking the teammate's turn loop.
 */

import type { MailboxMessage } from './mailbox';

export class MessageWaiter {
  private _resolve: ((msgs: MailboxMessage[]) => void) | null = null;
  private _reject: ((reason: Error) => void) | null = null;
  private _timeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Block until messages arrive or timeout expires.
   * Returns null on timeout, messages array on delivery, throws on cancel.
   */
  wait(timeoutMs: number): Promise<MailboxMessage[] | null> {
    return new Promise<MailboxMessage[] | null>((resolve, reject) => {
      this._resolve = (msgs) => {
        this._clearTimeout();
        resolve(msgs);
      };
      this._reject = (err) => {
        this._clearTimeout();
        reject(err);
      };

      this._timeout = setTimeout(() => {
        this._resolve = null;
        this._reject = null;
        resolve(null); // Timeout — no messages
      }, timeoutMs);
    });
  }

  /**
   * Deliver messages to the waiting teammate, resolving the promise.
   * Returns true if a waiter was active and resolved, false if no one was waiting.
   */
  deliver(msgs: MailboxMessage[]): boolean {
    if (this._resolve) {
      this._resolve(msgs);
      this._resolve = null;
      this._reject = null;
      return true;
    }
    return false;
  }

  /**
   * Cancel the wait (e.g. for abort/interrupt). Rejects the promise.
   */
  cancel(): void {
    this._clearTimeout();
    if (this._reject) {
      this._reject(new Error('MessageWaiter cancelled'));
      this._resolve = null;
      this._reject = null;
    }
  }

  /**
   * Whether a waiter is currently blocking (teammate is idle).
   */
  get isWaiting(): boolean {
    return this._resolve !== null;
  }

  private _clearTimeout(): void {
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }
}
