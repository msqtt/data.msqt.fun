import { createProvider, type Manifest } from '@wtop/provider';
import manifestJson from '../public/.well-known/wtop-manifest.json';
import * as ops from './ops';

const manifest = manifestJson as Manifest;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const message = $('message');

const OPS: Record<string, (p: never) => Promise<unknown>> = {
  collections: ops.collections,
  put: ops.put as never,
  get: ops.get as never,
  query: ops.query as never,
  delete: ops.deleteRecords as never,
  drop: ops.drop as never,
  transform: ops.transform as never,
  csvParse: ops.csvParse as never,
  csvFormat: ops.csvFormat as never,
  export: ops.exportCollection as never,
  import: ops.importFile as never,
};

const provider = createProvider({
  manifest,
  hostOrigins: [
    'https://recycle.msqt.fun',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5179',
    'http://127.0.0.1:5179',
  ],
  autoHandshake: false,
  mirror: {
    start: ({ method }) => ok(`HOST 调用 ${method}…`),
    result: ({ method, data }) => {
      const r = data as Record<string, unknown>;
      if (method === 'transform') {
        $<HTMLTextAreaElement>('tf-out').value = JSON.stringify(r.result, null, 2);
        ok('HOST 求值完成');
        return;
      }
      if (method === 'csvParse') {
        $<HTMLTextAreaElement>('csv-out').value = JSON.stringify(r.records, null, 2);
        ok(`HOST 解析 ${r.count} 条`);
        return;
      }
      if (method === 'csvFormat') {
        $<HTMLTextAreaElement>('csvfmt-out').value = String(r.csv ?? '');
        ok('HOST 转换完成');
        return;
      }
      ok(`HOST ${method} 完成`);
      void (async () => { await refreshCollections(); if (currentCol) await runQuery(); })().catch(fail);
    },
    error: ({ error }) => fail(new Error(`[${error.code}] ${error.message}`)),
  },
});
for (const [name, fn] of Object.entries(OPS)) provider.registerMethod(name, async (p) => fn(p as never));

const PAGE = 20;
let currentCol = '';
let offset = 0;
let total = 0;
let selectedId: string | null = null;

function ok(text: string) { message.textContent = text; message.classList.remove('err'); }
function fail(e: unknown) {
  message.textContent = e instanceof Error ? e.message : String(e);
  message.classList.add('err');
}

async function refreshCollections() {
  const { collections } = await ops.collections();
  const box = $('collections');
  box.innerHTML = '';
  for (const c of collections) {
    const btn = document.createElement('button');
    btn.className = `col-item${c.name === currentCol ? ' active' : ''}`;
    btn.dataset.col = c.name;
    btn.textContent = `${c.name}（${c.count}）`;
    btn.addEventListener('click', () => { void openCollection(c.name); });
    box.appendChild(btn);
  }
  if (!collections.length) box.innerHTML = '<p class="hint">还没有集合。输入名字点「打开」即可新建。</p>';
}

async function openCollection(name: string) {
  currentCol = name.trim();
  offset = 0;
  selectedId = null;
  $('current-col').textContent = `当前：${currentCol}`;
  $<HTMLInputElement>('col-name').value = currentCol;
  await runQuery();
  await refreshCollections();
}

async function runQuery() {
  if (!currentCol) { $('records').innerHTML = ''; $('rec-count').textContent = '0 条'; return; }
  const filter = $<HTMLInputElement>('query-filter').value.trim();
  const sort = $<HTMLInputElement>('query-sort').value.trim();
  const r = await ops.query({
    collection: currentCol,
    filter: filter || undefined,
    sort: sort || undefined,
    order: $<HTMLSelectElement>('query-order').value as 'asc' | 'desc',
    limit: PAGE,
    offset,
  });
  total = r.total;
  const box = $('records');
  box.innerHTML = '';
  for (const rec of r.records) {
    const div = document.createElement('div');
    div.className = 'rec-row';
    const id = String(rec.id ?? '');
    div.dataset.id = id;
    div.textContent = `${id || '(无 id)'} · ${JSON.stringify(rec).slice(0, 90)}`;
    div.addEventListener('click', () => {
      selectedId = id || null;
      $<HTMLTextAreaElement>('editor').value = JSON.stringify(rec, null, 2);
      document.querySelectorAll('.rec-row').forEach((el) => el.classList.toggle('active', el === div));
    });
    box.appendChild(div);
  }
  $('rec-count').textContent = `${r.total} 条`;
  $('page-info').textContent = `${offset + 1}–${offset + r.count} / ${r.total}`;
}

$('col-open').addEventListener('click', () => {
  const name = $<HTMLInputElement>('col-name').value.trim();
  if (!name) { fail(new Error('请输入集合名')); return; }
  void openCollection(name).catch(fail);
});
$('refresh').addEventListener('click', () => void refreshCollections().catch(fail));
$('query-run').addEventListener('click', () => { offset = 0; void runQuery().catch(fail); });
$('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); void runQuery().catch(fail); });
$('next').addEventListener('click', () => { if (offset + PAGE < total) { offset += PAGE; void runQuery().catch(fail); } });

$('add-new').addEventListener('click', () => {
  selectedId = null;
  $<HTMLTextAreaElement>('editor').value = '{\n  \n}';
});
$('save').addEventListener('click', () => void (async () => {
  if (!currentCol) throw new Error('请先打开一个集合');
  const rec = JSON.parse($<HTMLTextAreaElement>('editor').value) as Record<string, unknown>;
  const r = await ops.put({ collection: currentCol, records: [rec] });
  ok(`已保存（新增 ${r.inserted} / 更新 ${r.updated}）`);
  await runQuery();
  await refreshCollections();
})().catch(fail));
$('delete').addEventListener('click', () => void (async () => {
  if (!currentCol || !selectedId) throw new Error('请先选择一条记录');
  if (!confirm(`删除记录 ${currentCol}/${selectedId}？`)) return;
  await ops.deleteRecords({ collection: currentCol, ids: [selectedId] });
  selectedId = null;
  $<HTMLTextAreaElement>('editor').value = '';
  ok('已删除');
  await runQuery();
  await refreshCollections();
})().catch(fail));
$('drop').addEventListener('click', () => void (async () => {
  if (!currentCol) throw new Error('请先打开一个集合');
  if (!confirm(`删除整个集合「${currentCol}」及其全部记录？`)) return;
  const r = await ops.drop({ collection: currentCol });
  ok(`集合已删除（${r.deleted} 条）`);
  currentCol = '';
  $('current-col').textContent = '未选择集合';
  await runQuery();
  await refreshCollections();
})().catch(fail));

$('import-run').addEventListener('click', () => void (async () => {
  if (!currentCol) throw new Error('请先打开一个集合（导入会自动创建）');
  const f = $<HTMLInputElement>('import-file').files?.[0];
  if (!f) throw new Error('请先选择文件');
  const r = await ops.importFile({ collection: currentCol, file: f });
  ok(`导入 ${r.imported} 条`);
  await runQuery();
  await refreshCollections();
})().catch(fail));

async function doExport(format: 'json' | 'csv') {
  if (!currentCol) throw new Error('请先打开一个集合');
  const r = await ops.exportCollection({ collection: currentCol, format });
  const url = URL.createObjectURL(r.file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentCol}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
  ok(`导出 ${r.count} 条`);
}
$('export-json').addEventListener('click', () => void doExport('json').catch(fail));
$('export-csv').addEventListener('click', () => void doExport('csv').catch(fail));

$('tf-run').addEventListener('click', () => void (async () => {
  const data = JSON.parse($<HTMLTextAreaElement>('tf-data').value);
  const r = await ops.transform({ data, expression: $<HTMLInputElement>('tf-expr').value });
  $<HTMLTextAreaElement>('tf-out').value = JSON.stringify(r.result, null, 2);
  ok('求值完成');
})().catch(fail));
$('csv-parse').addEventListener('click', () => void (async () => {
  const r = await ops.csvParse({ csv: $<HTMLTextAreaElement>('csv-in').value });
  $<HTMLTextAreaElement>('csv-out').value = JSON.stringify(r.records, null, 2);
  ok(`解析 ${r.count} 条`);
})().catch(fail));
$('csvfmt-run').addEventListener('click', () => void (async () => {
  const records = JSON.parse($<HTMLTextAreaElement>('csvfmt-in').value) as Record<string, unknown>[];
  const r = await ops.csvFormat({ records });
  $<HTMLTextAreaElement>('csvfmt-out').value = r.csv;
  ok('转换完成');
})().catch(fail));

const inIframe = window.parent !== window;
if (inIframe) {
  void provider.start();
  const timer = setInterval(() => {
    statusEl.textContent = `WTOP: ${provider.state}`;
    statusEl.dataset.state = provider.state;
    if (provider.state === 'ready' || provider.state === 'failed') clearInterval(timer);
  }, 200);
} else {
  statusEl.textContent = '独立模式';
  statusEl.dataset.state = 'idle';
}

void (async () => {
  try {
    await refreshCollections();
  } catch (e) {
    $('origin-warn').classList.remove('hidden');
    fail(e);
  }
})();