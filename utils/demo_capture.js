'use strict';

/**
 * demo_capture.js — singleton side-effect interceptor for the /demo simulator.
 *
 * Usage:
 *   demoCapture.start()          before calling handleInbound
 *   demoCapture.stop()           after the call returns
 *   demoCapture.drain()          returns and clears all events recorded this session
 *   demoCapture.record(type, p)  called by whatsapp.service, lead_agent, etc.
 *   demoCapture.isActive()       true while a demo request is in flight
 *
 * Not concurrent-safe — fine for a local dev tool where one request runs at a time.
 */
class DemoCapture {
  constructor() {
    this._active = false;
    this._events = [];
  }

  start() {
    this._active = true;
    this._events = [];
  }

  stop() {
    this._active = false;
  }

  isActive() {
    return this._active;
  }

  /**
   * Record a side-effect event.
   * @param {string} type   - e.g. 'alert_owner', 'score_changed', 'qual_flag_changed'
   * @param {object} payload - arbitrary serialisable data
   */
  record(type, payload) {
    if (!this._active) return;
    this._events.push({
      id:      `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts:      new Date().toISOString(),
      type,
      payload: payload ?? {},
    });
  }

  /** Returns all events recorded since start() and clears the buffer. */
  drain() {
    const events = [...this._events];
    this._events = [];
    return events;
  }

  /** Returns events without clearing (for inspecting mid-flight). */
  peek() {
    return [...this._events];
  }
}

module.exports = new DemoCapture();
