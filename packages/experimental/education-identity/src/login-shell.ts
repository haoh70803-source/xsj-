/** Public sign-in document; private modules and APIs remain behind employee admission. */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { EducationIdentity } from '@deepseek-ai/dsh-experimental-education-platform'
import type {} from '@deepseek-ai/dsh-host-webserver'

const copy = {
  zh: { title: '鑫世界工作台', intro: '用真实的自己，创作有价值的内容。', username: '用户名', password: '密码', submit: '登录工作台', pending: '正在登录…', failed: '登录失败，请检查用户名和密码后重试。', network: '暂时无法连接，请稍后重试。' },
  en: { title: 'Writing workspace', intro: 'Create useful content, grounded in your own experience.', username: 'Username', password: 'Password', submit: 'Sign in', pending: 'Signing in…', failed: 'Sign-in failed. Check your username and password and try again.', network: 'Connection unavailable. Please try again.' },
}

/**
 * Register a same-origin login page without exposing the authenticated application graph.
 * @param ctx - route owner.
 * @param identity - configured identity origin and authentication service.
 */
export function mountLoginShell(ctx: Context, identity: EducationIdentity): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/education/sign-in', handler: (req, res) => {
    if (req.headers.host !== new URL(identity.publicOrigin).host) { res.writeHead(403); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    const language = req.headers['accept-language']?.startsWith('en') ? 'en' : 'zh'
    const t = copy[language]
    const nonce = randomBytes(18).toString('base64')
    const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f6f7f9;color:#20242c;font:16px/1.6 system-ui,sans-serif}main{width:min(100%,420px);background:white;padding:32px;border:1px solid #e1e4e9;border-radius:16px}h1{font-size:26px;margin:0 0 8px}p{color:#525b68}label{display:grid;gap:6px;margin:18px 0}input,button{font:inherit;min-height:46px;border:1px solid #8c95a2;border-radius:8px;padding:10px 12px;width:100%}button{background:#24624c;color:white;border-color:#24624c;cursor:pointer}button:disabled{opacity:.6;cursor:wait}:focus-visible{outline:3px solid #296bce;outline-offset:3px}[role=alert]{color:#a12626;min-height:26px}@media(prefers-reduced-motion:no-preference){button{transition:background .15s}}</style></head>
<body><main><h1>${t.title}</h1><p>${t.intro}</p><form><label>${t.username}<input name="username" autocomplete="username" minlength="3" maxlength="32" required></label><label>${t.password}<input name="password" type="password" autocomplete="current-password" required></label><p role="alert" aria-live="polite"></p><button>${t.submit}</button></form></main>
<script nonce="${nonce}">const form=document.querySelector('form'),button=form.querySelector('button'),error=form.querySelector('[role=alert]'),copy=${JSON.stringify(t)};form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;button.textContent=copy.pending;error.textContent='';const data=new FormData(form);try{const response=await fetch('/education/auth/sign-in',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:data.get('username'),password:data.get('password')})});form.elements.password.value='';if(response.ok){location.replace('/');return}error.textContent=copy.failed}catch{error.textContent=copy.network}finally{button.disabled=false;button.textContent=copy.submit}});</script></body></html>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` })
    res.end(req.method === 'HEAD' ? undefined : html)
  } }), 'education-identity: public sign-in document')
}
