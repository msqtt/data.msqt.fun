# data.msqt.fun · 数据仓库

通用文档存储 + 数据处理节点站（WTOP 协议，可被 [recycle.msqt.fun](https://recycle.msqt.fun) 编排，也可独立使用）。

- **存储**：IndexedDB 集合 CRUD（put/get/query/delete/drop），数据不出浏览器。
- **查询/变换**：JSONata 过滤、排序、分页；transform 纯函数求值。
- **CSV**：解析（RFC4180 子集）/ 生成 / 集合导入导出（JSON/CSV）。
- 11 个 WTOP 方法，manifest 见 `public/.well-known/wtop-manifest.json`。

## 开发

```bash
pnpm install
pnpm dev      # http://localhost:5184
pnpm build
```

## 嵌入 HOST 注意

注册到 HOST 时**必须勾选 allow-same-origin**：本站数据存于 IndexedDB，需要真实 origin；
勾选后嵌入与独立访问共享同一份数据。未勾选时所有方法返回友好错误提示。