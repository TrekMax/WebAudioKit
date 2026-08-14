# WebAudioKit 部署指南

本文档说明如何将 WebAudioKit 部署到一台公网 Linux 服务器。推荐方案是：本地构建静态文件，通过 `rsync` 上传到版本化目录，由 Nginx 提供静态站点，并使用 Certbot 配置 HTTPS。

WebAudioKit 是浏览器端、本地优先的音频分析应用。生产环境只需要发布 Vite 构建生成的 `dist/`，不需要在服务器常驻 Node.js、PM2、数据库或业务后端。用户导入的音频仍在浏览器本地处理，不会因为采用本方案而上传到服务器。

## 1. 推荐部署结构

建议使用独立子域名，并将应用部署在域名根路径，例如：

```text
https://audio.example.com/
```

服务器目录采用版本化发布与软链接切换：

```text
/var/www/webaudiokit/
├── current -> releases/7f610fd
└── releases/
    ├── 7f610fd/
    └── previous-release/
```

这样可以在不覆盖当前版本的情况下上传新版本，并通过切换 `current` 软链接完成原子发布和快速回滚。

本文命令中的以下示例值需要替换为实际配置：

| 示例值 | 含义 |
| --- | --- |
| `audio.example.com` | 应用域名 |
| `203.0.113.10` | 公网服务器 IP |
| `deploy` | 服务器登录用户 |
| `7f610fd` | 本次发布 ID，建议使用 Git 短提交号 |

## 2. 上线前准备

### 2.1 DNS 与防火墙

在域名服务商处添加 DNS 记录：

- `A` 记录指向服务器公网 IPv4 地址。
- 如果服务器已正确配置公网 IPv6，再添加 `AAAA` 记录；没有可用 IPv6 时不要添加。

服务器或云厂商安全组至少需要放行：

- TCP 22：SSH 管理。
- TCP 80：HTTP 和证书签发验证。
- TCP 443：HTTPS。

等待 DNS 生效后，可从本地检查：

```bash
dig +short audio.example.com
```

### 2.2 确认部署路径

当前 Vite 配置使用默认 `base: '/'`，因此推荐部署在独立域名的根路径。

如果必须部署到 `https://example.com/webaudiokit/` 这样的子路径，需要先在 `vite.config.ts` 中配置：

```ts
export default defineConfig({
  base: '/webaudiokit/',
  // 其余配置保持不变
})
```

修改后必须重新构建。不能只把原本面向根路径的 `dist/` 移到子目录，否则脚本、Worker 和 AudioWorklet 资源可能返回 404。

## 3. 首次部署

以下示例以 Debian/Ubuntu 服务器为例。其他发行版可使用对应包管理器安装 Nginx。

### 3.1 在本地构建

在仓库根目录执行：

```bash
npm ci
npm run check
```

`npm run check` 会执行项目定义的检查并生成生产构建。完成后确认存在 `dist/index.html` 和 `dist/assets/`：

```bash
find dist -maxdepth 2 -type f | sort | head -n 20
```

不要使用 `vite preview` 作为生产服务器；它只用于本地预览构建结果。

### 3.2 安装 Nginx 并准备目录

登录服务器：

```bash
ssh deploy@203.0.113.10
```

安装 Nginx：

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

创建发布目录，并让部署用户可以写入：

```bash
sudo install -d -o deploy -g www-data /var/www/webaudiokit
sudo install -d -o deploy -g www-data /var/www/webaudiokit/releases
install -d /var/www/webaudiokit/releases/7f610fd
```

### 3.3 上传静态文件

回到本地仓库根目录，上传 `dist/` 中的内容：

```bash
rsync -az --info=progress2 dist/ \
  deploy@203.0.113.10:/var/www/webaudiokit/releases/7f610fd/
```

上传完成后，在服务器切换当前版本：

```bash
sudo ln -sfn /var/www/webaudiokit/releases/7f610fd \
  /var/www/webaudiokit/current
```

### 3.4 配置 Nginx

在服务器创建 `/etc/nginx/sites-available/webaudiokit`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name audio.example.com;

    root /var/www/webaudiokit/current;
    index index.html;
    charset utf-8;
    server_tokens off;

    gzip on;
    gzip_vary on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "DENY" always;

    # 当前构建会生成 source map；公网环境默认不对外提供。
    location ~* \.map$ {
        return 404;
    }

    # Vite 产物带内容哈希，可以长期缓存；缺失资源必须返回 404，
    # 不能回退到 index.html，否则 Worker 会收到错误的 MIME 类型。
    location /assets/ {
        try_files $uri =404;

        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header X-Frame-Options "DENY" always;
    }

    # HTML 每次重新验证，避免发布后继续引用旧版本资源。
    location = /index.html {
        try_files $uri =404;

        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header X-Frame-Options "DENY" always;
    }

    # 保留单页应用的路由回退能力。
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

启用站点并验证配置：

```bash
sudo ln -s /etc/nginx/sites-available/webaudiokit \
  /etc/nginx/sites-enabled/webaudiokit
sudo nginx -t
sudo systemctl reload nginx
```

如果 `/etc/nginx/sites-enabled/webaudiokit` 已存在，不需要再次创建软链接。配置生效后先验证 HTTP：

```bash
curl -I http://audio.example.com/
```

### 3.5 配置 HTTPS

AudioWorklet 等浏览器能力依赖安全上下文，公网部署必须使用 HTTPS。以下为 Certbot 官方推荐的 snap 安装方式之一：

```bash
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
sudo certbot --nginx -d audio.example.com
```

签发完成后检查自动续期：

```bash
sudo certbot renew --dry-run
```

最后访问：

```text
https://audio.example.com/
```

浏览器控制台中应满足：

```js
window.isSecureContext === true
```

## 4. 日常发布

每次发布使用新的目录，避免覆盖当前正在服务的文件。

### 4.1 本地检查与构建

```bash
git pull --ff-only
npm ci
npm run check
git rev-parse --short HEAD
```

假设最后一条命令输出 `abc1234`，则上传到新目录：

```bash
ssh deploy@203.0.113.10 \
  'install -d /var/www/webaudiokit/releases/abc1234'

rsync -az --info=progress2 dist/ \
  deploy@203.0.113.10:/var/www/webaudiokit/releases/abc1234/
```

### 4.2 切换版本

先在服务器确认新版本入口存在：

```bash
test -f /var/www/webaudiokit/releases/abc1234/index.html
```

然后切换软链接：

```bash
sudo ln -sfn /var/www/webaudiokit/releases/abc1234 \
  /var/www/webaudiokit/current
```

静态内容切换不需要重启 Nginx。只有修改 Nginx 配置时才需要执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

确认新版本验收通过后再按团队保留策略清理旧发布目录。删除旧版本前应先确认它不是 `current` 指向的目录，也不是计划保留的回滚版本。

## 5. 回滚

找到上一个已验证的发布目录，然后重新指向该版本：

```bash
readlink -f /var/www/webaudiokit/current
ls -1 /var/www/webaudiokit/releases

sudo ln -sfn /var/www/webaudiokit/releases/7f610fd \
  /var/www/webaudiokit/current
```

回滚静态内容同样不需要重启 Nginx。切换后重新执行下面的上线验收。

## 6. 上线验收

### 6.1 HTTP、缓存与 MIME 类型

检查首页：

```bash
curl -I https://audio.example.com/
```

预期：

- 状态码为 `200`。
- 存在有效 TLS 证书。
- HTML 的 `Cache-Control` 为 `no-cache` 或更严格策略。
- 响应包含 `X-Content-Type-Options: nosniff`。

从 `dist/index.html` 或浏览器网络面板取一个实际的 JavaScript 资源路径，再检查：

```bash
curl -I https://audio.example.com/assets/example-hash.js
```

将示例路径替换为真实文件名。预期：

- 状态码为 `200`。
- `Content-Type` 为 JavaScript 类型，而不是 `text/html`。
- `Cache-Control` 包含长期缓存策略。

再请求一个不存在的资源：

```bash
curl -I https://audio.example.com/assets/not-found.js
```

预期状态码为 `404`，响应内容不能是 `index.html`。

### 6.2 产品功能冒烟测试

至少使用一段已知正常的 WAV 音频验证：

1. 页面无控制台资源错误，导航和知识图谱正常显示。
2. 导入音频后可以播放、暂停、停止、拖动和设置选区。
3. 波形、实时频谱、离线声谱图和 Three.js 3D 视图正常显示。
4. 重采样器可以切换算法，AudioWorklet 初始化无安全上下文错误。
5. WAV、CSV、JSON、PNG、JPG、SVG 等导出按当前功能正常工作。
6. 刷新页面和直接访问应用内路径时不会出现 Nginx 404。
7. WebGL2 不可用时，应用按设计降级且不会阻断其他分析功能。

## 7. 常见问题

### 页面能打开，但 Worker 或 AudioWorklet 加载失败

依次检查：

- 页面是否通过 HTTPS 打开，`window.isSecureContext` 是否为 `true`。
- Worker 脚本是否返回 JavaScript MIME 类型。
- `/assets/` 下不存在的文件是否错误回退到了 `index.html`。
- Nginx 是否有额外的代理或缓存规则改写资源响应。

### 发布后仍加载旧页面，或出现旧 Chunk 404

确认 `index.html` 没有长期缓存，同时 `/assets/` 的带哈希文件使用长期缓存。不要在原发布目录中边上传边覆盖文件，应上传到新目录后再切换 `current`。

### 部署到子路径后页面空白

确认 `vite.config.ts` 的 `base` 与实际 URL 前缀完全一致，然后重新构建并上传。检查 HTML 中的脚本地址是否带正确前缀。

### HTTPS 证书签发失败

确认：

- 域名已解析到当前服务器。
- TCP 80 可以从公网访问。
- Nginx 配置测试通过且正在运行。
- 如果配置了 `AAAA`，IPv6 也确实指向并能访问当前服务器。

### 是否需要公开 source map

当前 `vite.config.ts` 设置了 `build.sourcemap: true`，便于定位生产问题。本指南通过 Nginx 对 `.map` 返回 404，避免默认公开源码映射。如果生产环境完全不需要 source map，也可以将该选项改为 `false` 后重新构建；如果需要接入错误追踪平台，应将 map 作为私有构建产物上传到平台，而不是直接公开。

## 8. 运维与安全建议

- 使用非 root 用户通过 SSH 部署，仅对必要的目录和命令授予权限。
- 禁止把私钥、服务器密码、证书或环境密钥提交到仓库。
- 定期安装系统与 Nginx 安全更新，并关注证书续期状态。
- 对 Nginx 访问日志进行容量控制和轮转；不要增加采集用户音频内容的逻辑。
- 部署前保留至少一个已验证版本，以便快速回滚。
- 本应用不要求跨源隔离，不要在未验证兼容性的情况下随意加入 COOP/COEP 头。

## 9. 官方参考

- [Vite：部署静态站点](https://vite.dev/guide/static-deploy.html)
- [MDN：AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Nginx：try_files](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files)
- [Nginx：响应头与缓存](https://nginx.org/en/docs/http/ngx_http_headers_module.html)
- [Certbot：Nginx 安装说明](https://certbot.eff.org/instructions?ws=nginx&os=snap)
