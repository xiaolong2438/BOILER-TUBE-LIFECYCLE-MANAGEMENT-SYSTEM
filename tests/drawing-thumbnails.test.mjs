import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const js = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
const start = js.indexOf('/* ===== 缩略图链路');
const end = js.indexOf('function drawingThumbPlaceholder');
assert.ok(start > 0 && end > start, '缩略图链路代码块必须存在');
const block = js.slice(start, end);

function createHarness({ responses = {}, canvasSupported = true, localOriginals = {} } = {}) {
  const requests = [];
  const writes = [];
  const state = {
    drawingThumbCache: new Map(),
    drawingThumbInflight: new Map(),
    drawingThumbMissing: new Set()
  };
  function FakeImage() {
    this.naturalWidth = 800;
    this.naturalHeight = 600;
  }
  Object.defineProperty(FakeImage.prototype, 'src', {
    set() { setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0); }
  });
  const context = {
    console,
    setTimeout,
    DRAWING_THUMB_PREFIX: 'boiler_drawing_thumb:',
    DRAWING_THUMB_MAX_SIDE: 480,
    DRAWING_THUMB_QUALITY: 0.72,
    DRAWING_THUMB_DATA_RE: /^data:image\/(?:jpeg|png|webp);base64,/,
    ...state,
    designDrawings: [
      { id: 'img1', fileType: 'image' },
      { id: 'pdf1', fileType: 'pdf' },
      { id: 'img2', fileType: 'image' }
    ],
    cloudStorageEnabled: () => true,
    cloudStorageRequest: async key => {
      requests.push(key);
      return Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : { found: false };
    },
    cloudStorageWrite: async (key, data) => {
      writes.push({ key, data });
      return { ok: true };
    },
    DRAWING_DATA_RE: /^data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\s]+$/,
    readCachedDrawingContent: async id => (localOriginals[id] || null),
    readCachedDrawingThumbnail: async () => null,
    writeCachedDrawingThumbnail: async () => true,
    removeCachedDrawingThumbnail: async () => {},
    document: {
      createElement: tag => {
        if (tag !== 'canvas') return {};
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => (canvasSupported
          ? { fillStyle: '', fillRect() {}, drawImage() {} }
          : null);
        canvas.toDataURL = () => (canvasSupported ? 'data:image/jpeg;base64,THUMB' : 'data:,');
        return canvas;
      }
    },
    Image: FakeImage
  };
  vm.createContext(context);
  vm.runInContext(block, context);
  return { context, requests, writes, state };
}

test('buildDrawingThumbnail 把图片缩成 JPEG，PDF 返回 null', async () => {
  const { context } = createHarness();
  const thumb = await vm.runInContext("buildDrawingThumbnail('data:image/png;base64,AAAA')", context);
  assert.equal(thumb, 'data:image/jpeg;base64,THUMB');
  const pdf = await vm.runInContext("buildDrawingThumbnail('data:application/pdf;base64,AAAA')", context);
  assert.equal(pdf, null, 'PDF 不生成缩略图');
});

test('无 canvas 的旧内核退回 null 而不是抛错', async () => {
  const { context } = createHarness({ canvasSupported: false });
  const thumb = await vm.runInContext("buildDrawingThumbnail('data:image/png;base64,AAAA')", context);
  assert.equal(thumb, null);
});

test('ensureDrawingThumbnail 合并并发请求并缓存结果', async () => {
  const { context, requests } = createHarness({
    responses: { 'boiler_drawing_thumb:img1': { found: true, value: 'data:image/jpeg;base64,CLOUD' } }
  });
  const first = await vm.runInContext("ensureDrawingThumbnail('img1')", context);
  const second = await vm.runInContext("ensureDrawingThumbnail('img1')", context);
  assert.equal(first.url, 'data:image/jpeg;base64,CLOUD');
  assert.equal(second.url, first.url);
  assert.equal(requests.length, 1, '同一张缩略图只请求一次');
});

test('PDF 与云端缺失的缩略图不产生请求', async () => {
  const { context, requests } = createHarness();
  assert.equal(await vm.runInContext("ensureDrawingThumbnail('pdf1')", context), null);
  assert.equal(requests.length, 0, 'PDF 卡片不查缩略图键');

  assert.equal(await vm.runInContext("ensureDrawingThumbnail('img1')", context), null);
  assert.equal(requests.length, 1);
  assert.equal(await vm.runInContext("ensureDrawingThumbnail('img1')", context), null);
  assert.equal(requests.length, 1, '确认 404 后本会话不再重复请求');
});

test('老图纸有本机原图缓存时就地补缩略图（不下载原图）', async () => {
  const { context, requests, writes } = createHarness({
    localOriginals: { img2: 'data:image/png;base64,AAAA' }
  });
  const thumb = await vm.runInContext("ensureDrawingThumbnail('img2')", context);
  assert.ok(thumb && thumb.url.startsWith('data:image/jpeg;base64,'), '应由本机原图生成缩略图');
  assert.equal(requests.length, 1, '只探测一次缩略图键');
  assert.equal(writes.length, 1, '补生成的缩略图回传云端供其他电脑使用');
});

test('storeDrawingThumbnail 写回云端并解除缺失标记', async () => {
  const { context, writes, state } = createHarness();
  await vm.runInContext("ensureDrawingThumbnail('img2')", context);
  assert.ok(state.drawingThumbMissing.has('img2'));
  const stored = await vm.runInContext("storeDrawingThumbnail('img2', 'data:image/png;base64,AAAA')", context);
  assert.equal(stored, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'boiler_drawing_thumb:img2');
  assert.equal(state.drawingThumbMissing.has('img2'), false, '补生成后应解除缺失标记');
  assert.ok(state.drawingThumbCache.has('img2'));
});
