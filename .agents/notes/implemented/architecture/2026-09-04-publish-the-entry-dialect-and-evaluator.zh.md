# Agent Note: Publish the entry-list dialect and the expression evaluator

Status: implemented

[English](2026-09-04-publish-the-entry-dialect-and-evaluator.md) | 中文

## Problem

仓库外的浏览器宿主用与 `dsh web` 在服务端相同的 bundle patch 层组合自己的客户端树。它本就能应用 `@deepseek-ai/cordis-plugin-include/patch` 发布的 patch 算法，但同一套组合中的另外两块够不到。

`!!js` YAML 方言此前只能通过 `@deepseek-ai/cordis-plugin-include` 触及，而它的 Include 类是文件支撑的。无法导入它的消费方只能为手头已有的任意 YAML 库手写一个标签。今天一致的两份标签定义，明天就可能分歧，而形似的方言接受与拒绝的文档，与 Loader 实际挂载的那套并不相同。

`!!js` `disabled` 表达式背后的求值器此前只能通过 loader 的包 barrel 触及，而该 barrel 会重新导出 Node module-loader 兼容层。`Entry.disabledOf` 用 `Boolean(evaluate(...))` 解析这类表达式；没有求值器的消费方要么拒绝所有表达式，要么重新实现这套强制转换。

## Decision

`@deepseek-ai/dsh-app-boot` 重新导出 `entryListSchema`。Profile 组合本就在那里——`composeEntries`、`loadOverlayPatches`、`renderConfigDump`——它们每一个都以该方言解析或打印。通过本包组合的调用方现在也通过它解析与转储，因此暂存文档会把 `!!js` 作为标签往返，而不是作为裸的 `__jsExpr` 映射。

loader 发布其 `./config/utils` 导出，映射到构建后的 `evaluate` / `interpolate` / `isJsExpr` 模块。该模块只导入 `@deepseek-ai/cosmokit`，不导入任何 `node:` 内建模块，因此它本就是浏览器安全的；只是此前没有任何不经过 barrel 就能到达它的 specifier。

仓库内调用方继续导入 `src/config/utils.ts`。tsconfig `paths` 映射不带子路径通配符，因此构建后的 specifier 会把源码平面的程序解析到 `lib/`，从而混淆两个平面。

## Consequences

浏览器消费方按与宿主相同的规则解析 `disabled` 表达式，作用域是代表 loader Context 的替身。`packages/boot/app-boot/tests/js-expression.spec.ts` 把每个随包发布的层的表达式钉在所服务的 web boot 安装的 `{ process: { platform: 'browser' } }` 作用域上，因此某个层一旦开始触及更多内容，会在本仓库内失败，而不是在消费方启动时失败。

两个导出都不改变任何既有 specifier，也不改变 Node 路径上的任何行为。

## Known gap

include 包的构建输出导入 `@deepseek-ai/cordis-plugin-loader/src/config/utils.ts`——一个原始 `.ts` specifier，它同时存活于 tsc emit 与 tsdown 打包结果中，而打包型消费方会把它解析为该模块的第二份副本。Tree-shaking 会把重复部分削减到 `isJsExpr` 这个谓词，它不持有状态，因此代价是体积而非正确性。把已发布的 specifier 改写为构建导出需要本次改动未引入的构建设施。

## Alternatives considered

**从 `@deepseek-ai/cordis-plugin-include/patch` 重新导出 `isJsExpr` 与 `evaluate`。** 消费方只需依赖一个包，但 include 包会因此拥有一份由 loader 声明的表面，而且求值器与 patch 应用毫无关系。

**放宽消费方的编译器设置并导入 vendored 源码。** vendored loader 刻意设置 `noImplicitAny: false`；导入其源码会把这份放宽带进一个已经选择严格模式的程序。
