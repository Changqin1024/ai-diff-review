# 发布与更新（PUBLISHING）

> 本文件仅用于开发/发布，**不会被打包进扩展**（已在 `.vscodeignore` 中排除），因此不会出现在插件市场页面上。

## 1. 准备工作

1. 用 Microsoft 账号登录 <https://marketplace.visualstudio.com/manage>，创建一个 **publisher**（发布者 ID，例如 `your-name`）。
2. 登录 <https://dev.azure.com> → 右上角 User settings → **Personal access tokens** → New Token：
   - Organization：`All accessible organizations`
   - Scopes：`Custom defined` → 勾选 **Marketplace → Manage**
   - 生成后立即复制 token（只显示一次）。PAT 有效期最长 1 年，过期需重新生成。
3. 检查 `package.json`：
   - `"publisher"` 必须是你的发布者 ID（本项目当前为 `changqin`，换账号时改这里）；
   - `"repository"` / `"homepage"` / `"bugs"` 已指向 GitHub 仓库；
   - `"icon": "media/icon.png"`（128×128 PNG，市场与扩展列表会显示它）。

> ⚠️ 上架后**不要改** `publisher` 或 `name`（包名），否则市场会视为新扩展，用户会装出两个（侧边栏会出现两个图标）。

## 2. 登录并发布

```bash
npx vsce login <publisher-id>   # 粘贴上一步的 PAT
npx vsce publish                # 打包并发布
# 或不交互：npx vsce publish -p <PAT>
```

发布成功后可在 <https://marketplace.visualstudio.com/manage> 查看，市场页面同步通常需要几分钟。

## 3. 发布更新

```bash
npx vsce publish patch   # 0.1.0 -> 0.1.1 并发布
npx vsce publish minor   # 0.1.0 -> 0.2.0
npx vsce publish major   # 0.1.0 -> 1.0.0
npx vsce publish         # 用 package.json 里已改好的 version 发布
```

同一版本不能重复发布，必须递增 `version`。

## 4. 预发布 / 撤销 / Open VSX

```bash
npx vsce publish --pre-release                         # 发布预发布版本
npx vsce unpublish <publisher>.<name>                  # 撤销整个扩展
npx vsce unpublish <publisher>.<name>@0.1.0            # 撤销指定版本
npx ovsx publish ai-diff-review-0.1.0.vsix -p <TOKEN>  # 发布到 Open VSX（VSCodium 用户）
```

Open VSX token 在 <https://open-vsx.org> 生成。

## 5. 用 GitHub Actions 自动发布（可选）

在仓库 Settings → Secrets 添加 `VSCE_PAT`，然后 `.github/workflows/publish.yml`：

```yaml
name: Publish
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx vsce publish -p ${{ secrets.VSCE_PAT }}
```

之后打 tag（如 `v0.1.1`）并推送即可自动发布。
