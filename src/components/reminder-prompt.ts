import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';

interface PromptHandlers {
  onConfirm: () => void;
  onCancel: () => void;
}

export class ReminderPrompt {
  private el: HTMLElement | null = null;
  private handlers: PromptHandlers | null = null;
  private focus: 'ok' | 'cancel' = 'ok';
  private title = '';
  private channelName = '';
  private locked = false;
  private scope: FocusScope | null = null;

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  // A locked reminder that hide mode conceals keeps its names out of the prompt.
  show(title: string, channelName: string, handlers: PromptHandlers, locked = false): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: 'prompt.reminder',
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => this.focus,
      });
    }
    this.handlers = handlers;
    this.focus = 'ok';
    this.title = title;
    this.channelName = channelName;
    this.locked = locked;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'reminder-prompt';
      // Self-activates on click; mark so the global click handler skips it.
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    // Last in <body>, so it paints above a prompt of its tier shown before it.
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    this.moveTo(this.focus, 'key');
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.handlers = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left': this.moveTo('ok', 'key'); break;
      case 'right': this.moveTo('cancel', 'key'); break;
      case 'select': this.focus === 'ok' ? this.confirm() : this.cancel(); break;
      case 'back': this.cancel(); break;
      default: break;
    }
  }

  private moveTo(focus: 'ok' | 'cancel', via: Via): void {
    this.focus = focus;
    this.scope?.focus(focus, via);
    Focus.flush();
  }

  private confirm(): void { const h = this.handlers; this.hide(); h?.onConfirm(); }
  private cancel(): void { const h = this.handlers; this.hide(); h?.onCancel(); }

  private render(): void {
    if (!this.el) return;
    morph(this.el, html`
      <div class="reminder-dialog">
        <p class="reminder-message">${this.locked ? t('reminder.lockedMessage') : t('reminder.message', {
          channel: this.channelName,
          title: this.title,
        })}</p>
        <div class="reminder-buttons">
          <button class="reminder-btn" data-focusable
                  data-key="ok" data-reminder-action="ok">${t('reminder.watchNow')}</button>
          <button class="reminder-btn" data-focusable
                  data-key="cancel" data-reminder-action="cancel">${t('common.cancel')}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('nav:hover', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-reminder-action]');
      if (!btn) return;
      this.moveTo(btn.dataset.reminderAction === 'ok' ? 'ok' : 'cancel', 'pointer');
    });

    // Hit-test the button under the pointer.
    this.el!.addEventListener('click', (e: MouseEvent) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const btn = hit?.closest<HTMLElement>('[data-reminder-action]');
      if (!btn) return;
      btn.dataset.reminderAction === 'ok' ? this.confirm() : this.cancel();
    });
  }
}
