// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { CatalogView } from './catalog-view';
import type { CatalogHandlers, ResumeKind } from '../types';

interface TestItem { streamId: string; name: string; poster: string; categoryId: string }
interface TestCat { id: string; name: string }

class TestCatalog extends CatalogView<TestCat, TestItem> {
  protected get kicker() { return 'Test'; }
  protected readonly resumeKind: ResumeKind = 'vod';
  protected get emptyMessage() { return ''; }
  protected get gridEmptyMessage() { return ''; }
  protected readonly parentalKind = 'vod' as const;
  protected itemCount(count: number) { return String(count); }
  protected async loadCategories() { return []; }
  protected async loadItems() { return []; }
  protected itemId(i: TestItem) { return i.streamId; }
  protected itemName(i: TestItem) { return i.name; }
  protected itemPoster(i: TestItem) { return i.poster; }
  protected itemCategoryId(i: TestItem) { return i.categoryId; }
  protected async openDetail() {}
  protected renderDetail() {}
  protected clearDetail() {}
  protected selectExtra() { return false; }
  protected continueRail() { return ''; }
  protected watchlistRail() { return ''; }
}

const handlers: CatalogHandlers = {
  onRevealTabBar: () => {},
  onBack: () => {},
  onPlayVod: () => {},
};

const container = document.createElement('div');
document.body.appendChild(container);
const view = new TestCatalog(container, handlers);

const poster = 'http://host/a/poster.jpg';
const item: TestItem = { streamId: 's1', name: 'Alpha', poster, categoryId: 'c1' };

function tileOf(item: TestItem): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = String(view.tile(item));
  return wrap.firstElementChild as HTMLElement;
}

describe('CatalogView lazy posters', () => {
  it('renders an eager poster with a src attribute (detail screens)', () => {
    const div = document.createElement('div');
    div.innerHTML = String(view.posterCell('Alpha', poster));
    const img = div.querySelector('img.catalog-poster')!;
    expect(img.getAttribute('src')).toBe(poster);
  });

  it('renders a lazy tile poster with data-src but no decoded src', () => {
    const div = document.createElement('div');
    div.innerHTML = String(view.posterCell('Alpha', poster, true));
    const box = div.querySelector('.catalog-poster-lazy')!;
    expect(box.getAttribute('data-src')).toBe(poster);
    const img = box.querySelector('img.catalog-poster-img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.style.display).toBe('');
    expect(div.querySelector('.catalog-poster-letter')?.textContent).toBe('A');
  });

  it('renders an empty placeholder when there is no poster', () => {
    const div = document.createElement('div');
    div.innerHTML = String(view.posterCell('Alpha', '', true));
    expect(div.querySelector('.catalog-poster-empty')).not.toBeNull();
    expect(div.querySelector('.catalog-poster-lazy')).toBeNull();
  });

  it('tile() renders a lazy poster (browse/grid rails)', () => {
    const tile = tileOf(item);
    const box = tile.querySelector('.catalog-poster-lazy[data-src]')!;
    expect(box.getAttribute('data-src')).toBe(poster);
    expect(tile.querySelector('img.catalog-poster[src]')).toBeNull();
  });

  it('decodes the focused tile poster and releases it on blur', () => {
    const tile = tileOf(item);
    const box = tile.querySelector('.catalog-poster-lazy[data-src]')!;
    const img = box.querySelector('img.catalog-poster-img')!;
    const letter = box.querySelector('.catalog-poster-letter')!;

    // Unfocused: placeholder letter shows, no image decoded.
    expect(img.getAttribute('src')).toBeNull();
    expect(letter.style.display).not.toBe('none');

    // Focus: decode the poster, hide the placeholder.
    (view as any).activateTilePoster(tile);
    expect(img.getAttribute('src')).toBe(poster);
    expect(img.style.display).toBe('block');
    expect(letter.style.display).toBe('none');

    // Blur: release the decoded bitmap, show the placeholder again.
    (view as any).deactivateTilePoster(tile);
    expect(img.getAttribute('src')).toBe('');
    expect(img.style.display).toBe('none');
    expect(letter.style.display).not.toBe('none');
  });
});
