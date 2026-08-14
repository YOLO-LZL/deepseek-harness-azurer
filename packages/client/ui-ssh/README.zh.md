# @deepseek-ai/dsh-client-ui-ssh

[English](README.md) | 中文

浏览器侧的 SSH 设置与工作区创建组件。该插件展示已保存的 SSH 连接，在设置服务写入前校验本地草稿，并通过 Host API 提供远端目录浏览。

## 模型体验

此浏览器侧 UI 不注册模型请求上下文。

#### KV Cache 效果

无：在浏览器中渲染或编辑 SSH 设置不会改变模型请求 token。

## Known Limitations and Deferred Work

- 远端目录操作要求 Host 进程具有可用的 OpenSSH 客户端并可连接目标；UI 展示 Host 结果，不提供自己的传输回退。
