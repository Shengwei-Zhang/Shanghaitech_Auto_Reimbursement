# 多用户部署（服务器 + nginx）

默认（`REIM_DEPLOYMENT=local`）报销助手是一个人在自己电脑上用：只接受 `http://127.0.0.1` 的访问，所有标签页共用一个会话。设置 `REIM_DEPLOYMENT=server` 后，同一个服务经 nginx 供多人使用。

## 多用户模式做了什么

| 方面 | local（默认） | server |
| --- | --- | --- |
| 本地会话 | 全局一个，所有标签页共用 | 每个浏览器一个（随机 Cookie + 各自的 CSRF 令牌） |
| 学校 OA 登录 | 一个；再次登录会替换 | 每个浏览器各自登录，互不影响；退出只结束自己的 |
| 用款申请单任务 | 属于 `local`，全部可见 | 属于该浏览器会话，别人既看不到也停不了 |
| 境内差旅单 | 同时一张 | 每个用户同时一张，不同用户并行 |
| 用款申请单并行 | 同时一个 | 接口方式（默认）的任务不设总数上限，不同用户同时执行；同一用户的多张单逐个执行。只有需要启动浏览器的任务（`OA_HTTP_FILL=false`，或 `OA_HTTP_SUBMIT=false` 的提交）同时最多 `REIM_MAX_ACTIVE_JOBS` 个（默认 2） |
| 票据识别 | 不限 | 同时最多 `REIM_MAX_PARSES` 个（默认 CPU 核数 − 1），其余排队；扫描件的本机 OCR 每个占一个核数秒 |
| 发给 OA 的请求 | — | 同一登录的写请求仍逐个发送（OA 对重叠请求回“登录超时”），不同用户之间并行 |
| `.env` 中的 `OA_USERNAME`/`OA_PASSWORD` | 可用“使用已保存账号”登录 | 不提供，每人输入自己的账号密码 |
| 访问地址 | 只接受 `127.0.0.1`/`localhost` | 只接受 `REIM_PUBLIC_ORIGIN`（须 https），Host 与 Origin 均须一致 |
| Cookie | `HttpOnly; SameSite=Strict` | 另加 `Secure` |
| 空闲 | — | 会话空闲 `REIM_SESSION_IDLE_MINUTES`（默认 120）分钟后结束，学校登录随之结束；会话总数超过 `REIM_MAX_SESSIONS` 时最久未用的让位 |
| 任务以外的接口 | 演示任务、带账号密码的浏览器任务 | 关闭（`POST /api/jobs`、`/start` 返回 404） |

页面、报销流程和发给 OA 的请求两种模式完全相同（请求基准测试保证）。

## 配置

`.env`（不要把真实账号密码写进服务器上的 `.env`；server 模式不会使用它们）：

```bash
OA_LIVE_ENABLED=true
REIM_DEPLOYMENT=server
REIM_PUBLIC_ORIGIN=https://reim.example.edu.cn
REIM_TRUST_PROXY=true
REIM_SESSION_IDLE_MINUTES=120
REIM_MAX_SESSIONS=200
REIM_MAX_ACTIVE_JOBS=2
REIM_MAX_PARSES=3
PORT=4317
```

服务仍只监听 `127.0.0.1:4317`，只有同一台机器上的 nginx 能访问它。在 `deploy` 分支上 `npm run start`，页面地址为 `https://reim.example.edu.cn/Reim-Copilot`。

## nginx

```nginx
limit_req_zone $binary_remote_addr zone=reim_api:10m rate=10r/s;

server {
    listen 443 ssl http2;
    server_name reim.example.edu.cn;
    ssl_certificate     /etc/ssl/reim/fullchain.pem;
    ssl_certificate_key /etc/ssl/reim/privkey.pem;

    # Invoices and 票据 are up to 8 MB each, sent as base64 in JSON.
    client_max_body_size 12m;
    # A fill or the OCR of a scan can take a while.
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    # Must be served at the root of the host: the page and API use absolute paths.
    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /api/ {
        limit_req zone=reim_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    # Request bodies hold passwords and invoices: never log them.
    access_log /var/log/nginx/reim.access.log;
}

server {
    listen 80;
    server_name reim.example.edu.cn;
    return 301 https://$host$request_uri;
}
```

要点：`Host` 必须原样转发（服务据此核对访问地址）；必须是 https（否则 Cookie 带 `Secure` 后浏览器不会发送）；只能挂在域名根上，不能放在子路径下；只运行一个服务实例（任务、会话都在这个进程的内存里，`data/server.lock` 也只允许一个）。

## 更新与版本

每个版本在仓库中有标签（如 `v4.1.0`），改动见 `CHANGELOG.md`；`deploy` 分支始终是最新版本。更新时先停止服务，再：

```bash
git pull && npm ci          # 最新版本（deploy 分支）
git checkout v4.1.0 && npm ci   # 或指定版本；回退到旧版本同理，回到最新：git checkout deploy && git pull
npm start
```

重启会结束所有人的学校登录，进行中的任务记为“已中断”，请避开使用高峰。启动日志和每页底部显示当前版本号，据此确认更新成功。数据目录（任务、统计、打印标记）在版本之间通用。

## 使用统计（管理员）

在 `.env` 中设置 `REIM_ADMIN_ACCOUNTS=工号`（可用逗号分隔多个）。用这个学校账号登录后，页面右上角出现“统计”，打开 `/admin`；其他账号看不到入口，直接访问统计接口也只会得到“接口不存在”。本机单用户模式不设置时，登录的本人即可查看。

| 内容 | 说明 |
| --- | --- |
| 现在 | 在线人数（最近 5 分钟有操作的浏览器）、其中已登录学校 OA 的、正在执行（用款申请单 / 差旅单）、排队中、会话总数；页面每 30 秒刷新 |
| 累计 | 服务用户数（登录过的不同学校账号）及其中发起过报销单的人数、处理报销单数、成功数（已提交 + 只保存成功）、成功率（不计已停止的）、登录次数、验证码次数、登录失败原因、在线峰值；按报销类型分列发起、已提交、已保存、待核对、失败、已停止 |
| 最近 30 天 | 每天的登录用户、登录次数、验证码、登录失败、在线峰值、发起、成功、失败 |

统计保存在 `<OA_DATA_DIR>/stats/stats.json`（`0600`），服务重启后保留。用户以学校账号加随机密钥（`stats/salt`，不离开该目录）的摘要计数，文件中没有工号、姓名、单据号或金额。删除 `stats` 目录即清零。“待核对”是 OA 结果不明、需要人工核对的单据，不算成功。

## 仍需注意

- **凭据经过服务器**：用户的学校密码经 https 到达本服务，用于登录后即丢弃，不写入磁盘；学校登录的 Cookie 只在内存中，用款申请单执行期间在任务目录中短暂保存（`0600`），执行结束即删除。部署前请确认学校信息化部门允许这种代为登录的方式。
- **服务器须能访问校园网**；所有用户的请求从同一 IP 发出，学校统一认证可能更频繁地要求验证码（页面会显示验证码）。
- **服务重启**：内存中的会话与学校登录全部结束，进行中的任务记为“已中断”，用户需重新登录并在 OA 中核对。
- **数据目录**：`OA_DATA_DIR` 下每个用户的任务记录含单据号、收款人和发票 PDF，请限制服务器账户与备份的访问。会话结束后任务记录仍保留在磁盘上，但无法再从页面查看；需要定期清理时按目录日期删除。
- **同一用户的多张单不能同时进行**：同一个学校登录的请求只能逐个发送（OA 对重叠请求回“登录超时”），所以一个人连续提交几张用款申请单时，它们排队依次填写和提交；不同用户之间互不等待。
- **本机 OCR 占用 CPU**：多人同时上传扫描件时由 `REIM_MAX_PARSES` 排队，按服务器核数调整。
- 本模式没有自己的账号体系：用户身份就是浏览器会话，登录的是各自的学校账号。需要单点登录或审计时，应在 nginx 前加学校的统一认证。
