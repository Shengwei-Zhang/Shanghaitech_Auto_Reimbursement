/** School login on the server: password or the .env account, captcha, logout. */
import { $, api, hideCaptcha, leave, page, pending, show, state } from './core.js';

function useSaved() {
  return Boolean(state.savedUsername) && !$('password').value && $('username').value.trim() === state.savedUsername;
}

function updatePasswordHint() {
  const saved = Boolean(state.savedUsername) && $('username').value.trim() === state.savedUsername;
  $('password').required = !saved;
  $('password').placeholder = saved ? '留空则使用 .env 中保存的密码' : '';
}

async function signIn(event) {
  event.preventDefault();
  $('login-error').hidden = true;
  $('login-button').disabled = true;
  pending($('busy-text'), '正在向学校统一身份认证登录…');
  $('busy').hidden = false;
  const answering = !$('captcha-row').hidden;
  try {
    const status = await api('POST', '/api/oa/login', answering ? { captcha: $('captcha').value.trim() }
      : useSaved() ? { useSaved: true } : { username: $('username').value.trim(), password: $('password').value });
    if (status.captcha?.image) {
      showCaptcha(status.captcha.image);
      return;
    }
    hideCaptcha();
    if (!status.loggedIn || !status.login) throw new Error('后台没有确认登录结果。');
    $('password').value = '';
    const { login } = status;
    state.account = login.userAccount;
    $('account-name').textContent = login.userName || login.userAccount;
    $('account-id').textContent = `工号 ${login.userAccount}`;
    $('account-avatar').textContent = (login.userName || login.userAccount).slice(0, 1);
    $('login-proof-title').textContent = `已于 ${new Date(login.at).toLocaleTimeString('zh-CN')} 由后台完成登录`
      + `${login.savedPassword ? '（密码取自 .env）' : ''}`;
    $('login-steps').replaceChildren(...login.steps.map(step => {
      const item = document.createElement('li');
      item.textContent = step;
      return item;
    }));
    $('login-screen').hidden = true;
    $('app').hidden = false;
    show('');
    page.reset(false);
    page.loadWorkbench();
  } catch (error) {
    // A wrong captcha or password ends that login on the school side; the next click starts over.
    if (answering) hideCaptcha();
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  } finally {
    $('busy').hidden = true;
    $('login-button').disabled = false;
  }
}

function showCaptcha(image) {
  $('captcha-image').src = image;
  $('captcha').value = '';
  $('captcha').required = true;
  $('captcha-row').hidden = false;
  $('username').readOnly = true;
  $('password').readOnly = true;
  $('login-button').textContent = '提交验证码并登录';
  $('login-error').textContent = '学校统一身份认证要求输入图形验证码。';
  $('login-error').hidden = false;
  $('captcha').focus();
}

async function refreshCaptcha() {
  try {
    const { captcha } = await api('POST', '/api/oa/login/captcha');
    $('captcha-image').src = captcha.image;
    $('captcha').value = '';
    $('captcha').focus();
  } catch (error) {
    hideCaptcha();
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  }
}


function initLogin() {
  $('login-form').addEventListener('submit', signIn);
  $('captcha-refresh').addEventListener('click', refreshCaptcha);
  $('username').addEventListener('input', updatePasswordHint);
  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/oa/logout').catch(() => undefined);
    leave('已退出登录。');
  });
}

/** The page's session (CSRF token, whether live runs are on) and the .env account, then the login form. */
async function startLogin() {
  try {
    const session = await api('GET', '/api/session');
    state.csrf = session.csrfToken;
    state.liveEnabled = session.liveEnabled === true;
    state.savedUsername = (await api('GET', '/api/oa/status')).savedUsername || '';
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  }
  if (state.savedUsername) $('username').value = state.savedUsername;
  updatePasswordHint();
  (state.savedUsername ? $('login-button') : $('username')).focus();
}

export { initLogin, startLogin };
