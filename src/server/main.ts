import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, PAGE_PATH } from './app';
import { loadSiteProfile } from '../infrastructure/site-profile';
import { deploymentFromEnv } from './deployment';
import { APP_VERSION } from './version';

dotenv.config();
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024–65535 的整数。');
const dataDir = path.resolve(process.env.OA_DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockFile = path.join(dataDir, 'server.lock');

// Enforce one writer/queue per local data directory, including servers on different ports.
function lock() {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('服务锁无效，请先检查是否存在其他运行实例。');
    try { process.kill(pid, 0); }
    catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    }
    throw new Error('该数据目录已被另一服务实例使用。');
  }
}
lock();
process.once('exit', () => {
  if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
});
// local (default): this computer only. server: several users behind nginx on this machine (docs/deployment.md).
const deployment = deploymentFromEnv();
const app = createApp({ dataDir, liveEnabled: process.env.OA_LIVE_ENABLED === 'true', deepSeekKey: process.env.DEEPSEEK_API_KEY,
  siteProfile: loadSiteProfile(process.env.OA_SITE_PROFILE), deployment });
app.server.once('error', error => { console.error(error.message); process.exitCode = 1; });
// Always 127.0.0.1: on a server only the proxy on this machine reaches it.
app.server.listen(port, '127.0.0.1', () => console.log(deployment.mode === 'server'
  ? `报销助手 v${APP_VERSION}（多用户）：${deployment.origins[0]}${PAGE_PATH}，经反向代理转发到 127.0.0.1:${port}`
  : `报销助手 v${APP_VERSION}：http://127.0.0.1:${port}${PAGE_PATH}`));
const shutdown = () => {
  app.service.shutdown();
  app.server.close();
  app.server.closeIdleConnections();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
