import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isCriticalConsoleLine(line = '') {
  const t = String(line || '').toLowerCase();
  return (
    t.includes('typeerror') ||
    t.includes('referenceerror') ||
    t.includes('matchmaking failed') ||
    t.includes('host session not bound') ||
    t.includes('checkauth_failed') ||
    t.includes('setactor is not a function') ||
    t.includes('roomid is required') ||
    t.includes('initializing multiplayerclient for room: undefined') ||
    t.includes('app id authority: your_app_id') ||
    t.includes('unhandled methods: viverse_sdk/checkauth:ack')
  );
}

function isAccountLoginUrl(url = '') {
  const u = String(url || '').toLowerCase();
  return u.includes('account.htcvive.com/login') || u.includes('account.htcvive.com/login/saml');
}

function isWorldsUrl(url = '') {
  return /https?:\/\/worlds\.viverse\.com/i.test(String(url || ''));
}

function deriveCheckStatusFromSnapshot(snapshot = {}) {
  const lines = Array.isArray(snapshot.console) ? snapshot.console : [];
  const critical = lines.filter((x) => isCriticalConsoleLine(x));
  const pageUrl = String(snapshot.url || '');
  const inWorldsContext = isWorldsUrl(pageUrl);
  const inAccountLogin = isAccountLoginUrl(pageUrl);
  const hasJoined = lines.some((x) =>
    /\[multiplayer\].*joined room/i.test(x) ||
    /\[game\].*connected to room/i.test(x) ||
    /\[game\].*actor id resolved/i.test(x)
  );
  const hasAppInitialized = lines.some((x) =>
    /\[viverse\].*app initialized/i.test(x) ||
    /\[diagnostic\].*app id:/i.test(x) ||
    /\[viverse\]\[auth_success\]/i.test(x)
  );
  const hasProfilePayload = lines.some((x) =>
    /\[viverse\].*(getuserinfo|getprofilebytoken|getprofile)/i.test(x) ||
    /\[diagnostic\].*user:/i.test(x)
  );
  const hasAuthReady = lines.some((x) =>
    /\[viverse\].*auth:\s*ready/i.test(x) ||
    /\[diagnostic\].*user authenticated:\s*true/i.test(x) ||
    /\[viverse\].*checkauth result:.*(access_token|account_id)/i.test(x)
  ) || hasAppInitialized || hasProfilePayload;
  const hasSystemFaultText = /system fault/i.test(String(snapshot.bodyText || ''));
  const hasNoSessionText = /waiting for viverse hub authentication|no session/i.test(String(snapshot.bodyText || ''));
  const hasPreviewSignIn = /play for free|sign in/i.test(String(snapshot.bodyText || ''));
  const appRuntimeEvidence = hasAppInitialized || hasProfilePayload;
  const authContextValid = inWorldsContext && !inAccountLogin;

  const authStatus =
    authContextValid &&
    appRuntimeEvidence &&
    hasAuthReady &&
    !hasNoSessionText &&
    !hasSystemFaultText &&
    !hasPreviewSignIn &&
    critical.length === 0
      ? 'pass'
      : 'fail';
  const matchmakingStatus =
    authContextValid && hasJoined && critical.length === 0 ? 'pass' : 'fail';

  return {
    auth_profile: {
      status: authStatus,
      proof:
        authStatus === 'pass'
          ? 'Browser logs indicate auth ready with no critical runtime faults.'
          : `Auth not fully healthy. url=${pageUrl || 'n/a'}, authContextValid=${authContextValid}, appRuntimeEvidence=${appRuntimeEvidence}, hasAuthReady=${hasAuthReady}, hasNoSessionText=${hasNoSessionText}, hasSystemFault=${hasSystemFaultText}, hasPreviewSignIn=${hasPreviewSignIn}, criticalErrors=${critical.length}`
    },
    matchmaking: {
      status: matchmakingStatus,
      proof:
        matchmakingStatus === 'pass'
          ? 'Browser logs include room join event with no critical runtime faults.'
          : `Matchmaking evidence insufficient. url=${pageUrl || 'n/a'}, authContextValid=${authContextValid}, hasJoined=${hasJoined}, criticalErrors=${critical.length}`
    },
    criticalErrors: critical
  };
}

class BrowserRuntimeTestService {
  constructor() {
    this._pageObservers = new WeakMap();
  }

  _boolEnv(name, fallback = false) {
    const v = String(process.env[name] ?? '').trim().toLowerCase();
    if (!v) return fallback;
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }

  async _pathExists(p) {
    try {
      await fs.access(p);
      return true;
    } catch (_) {
      return false;
    }
  }

  async _waitForManualLogin(context, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pages = context.pages();
      for (const p of pages) {
        const url = p.url();
        if (/worlds\.viverse\.com/i.test(url)) {
          const s = await this._verifyWorldsLoggedIn(p);
          if (s.ok) {
            return { ok: true, reason: 'manual_login_confirmed', snippet: s.snippet };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return { ok: false, reason: 'manual_login_timeout', snippet: '' };
  }

  async _verifyWorldsLoggedIn(page) {
    try {
      await page.goto('https://worlds.viverse.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const state = await page.evaluate(() => {
        const body = (document?.body?.innerText || '').toLowerCase();
        const hasSignInText = body.includes('sign in');
        const hasPrivateMessage = body.includes('only the owner can access this world');
        return { hasSignInText, hasPrivateMessage, snippet: (document?.body?.innerText || '').slice(0, 2000) };
      }).catch(() => ({ hasSignInText: true, hasPrivateMessage: false, snippet: '' }));
      return {
        ok: !state.hasSignInText,
        reason: !state.hasSignInText ? 'worlds_session_detected' : 'worlds_still_shows_signin',
        snippet: state.snippet
      };
    } catch (err) {
      return {
        ok: false,
        reason: `worlds_session_check_error:${String(err?.message || err || 'unknown')}`,
        snippet: ''
      };
    }
  }

  _targets(page) {
    const out = [page];
    try {
      const frames = page.frames?.() || [];
      for (const f of frames) out.push(f);
    } catch (_) {
      // ignore
    }
    return out;
  }

  async _tryFill(page, selectors = [], value = '') {
    for (const selector of selectors) {
      for (const target of this._targets(page)) {
        try {
          const el = target.locator(selector).first();
          if ((await el.count()) > 0) {
            await el.fill(value, { timeout: 3000 });
            return true;
          }
        } catch (_) {
          // try next selector/frame
        }
      }
    }
    return false;
  }

  async _tryClick(page, selectors = []) {
    for (const selector of selectors) {
      for (const target of this._targets(page)) {
        try {
          const el = target.locator(selector).first();
          if ((await el.count()) > 0) {
            await el.click({ timeout: 3000 });
            return true;
          }
        } catch (_) {
          // try next selector/frame
        }
      }
    }
    return false;
  }

  async _loginToViverse(page, credentials, artifactsDir = '') {
    if (!credentials?.email || !credentials?.password) {
      return { ok: false, reason: 'missing_credentials' };
    }

    const email = String(credentials.email);
    const password = String(credentials.password);
    const result = { ok: false, reason: 'unknown' };

    try {
      // Start from Worlds and trigger Sign In (some flows open popup/new tab).
      await page.goto('https://worlds.viverse.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const popupPromise = page.context().waitForEvent('page', { timeout: 7000 }).catch(() => null);
      await this._tryClick(page, [
        'button:has-text("Sign In")',
        'a:has-text("Sign In")',
        'text=Sign In'
      ]);
      let authPage = await popupPromise;
      if (!authPage) authPage = page;
      await authPage.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => {});
      await authPage.waitForTimeout(1200);

      // If no auth surface appeared, force account portal.
      const maybeEmailPresent = await this._tryFill(authPage, [
        'input[type="email"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
        'input[autocomplete="username"]'
      ], email);
      if (!maybeEmailPresent) {
        await authPage.goto('https://account.htcvive.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await authPage.waitForTimeout(1200);
      }

      // Some flows need explicit "use email/password" switching.
      await this._tryClick(authPage, [
        'button:has-text("Use email")',
        'a:has-text("Use email")',
        'button:has-text("Email")',
        'a:has-text("Email")'
      ]);
      await authPage.waitForTimeout(500);

      const emailFilled = await this._tryFill(authPage, [
        'input[type="email"]',
        'input[type="text"]',
        'input[type="tel"]',
        'input[name*="email" i]',
        'input[name*="account" i]',
        'input[name*="user" i]',
        'input[id*="email" i]',
        'input[id*="account" i]',
        'input[id*="user" i]',
        'input[autocomplete="username"]'
      ], email);

      if (!emailFilled) {
        // Generic fallback for account forms that use plain text input without semantic attributes.
        try {
          const fallbackUserInput = authPage.locator('input:not([type="hidden"]):not([type="password"])').first();
          if ((await fallbackUserInput.count()) > 0) {
            await fallbackUserInput.fill(email, { timeout: 3000 });
          } else {
            result.reason = 'email_field_not_found';
            result.loginUrl = authPage.url();
            result.bodySnippet = await authPage.evaluate(() => (document?.body?.innerText || '').slice(0, 2000)).catch(() => '');
            return result;
          }
        } catch (_) {
          result.reason = 'email_field_not_found';
          result.loginUrl = authPage.url();
          result.bodySnippet = await authPage.evaluate(() => (document?.body?.innerText || '').slice(0, 2000)).catch(() => '');
          return result;
        }
      }

      await this._tryClick(authPage, [
        'button:has-text("Next")',
        'button[type="submit"]',
        'input[type="submit"]',
        'text=Continue'
      ]);
      await authPage.waitForTimeout(1400);

      const passwordFilled = await this._tryFill(authPage, [
        'input[type="password"]',
        'input[name*="password" i]',
        'input[id*="password" i]',
        'input[autocomplete="current-password"]'
      ], password);

      if (!passwordFilled) {
        result.reason = 'password_field_not_found';
        return result;
      }

      await this._tryClick(authPage, [
        'button:has-text("Sign In")',
        'button:has-text("Log In")',
        'button[type="submit"]',
        'input[type="submit"]'
      ]);

      await authPage.waitForTimeout(6000);
      const bodyText = await authPage.evaluate(() => (document?.body?.innerText || '').slice(0, 3000)).catch(() => '');
      const hasAuthError = /invalid|incorrect|failed|error/i.test(String(bodyText || ''));
      const hasSignInUi = /\bsign in\b/i.test(String(bodyText || ''));
      const hasRecaptchaUi = /recaptcha|not a bot/i.test(String(bodyText || ''));
      const loginUrl = authPage.url();
      const stillOnAccountLogin = isAccountLoginUrl(loginUrl);
      const cookies = await page.context().cookies().catch(() => []);
      const hasSessionCookie = Array.isArray(cookies) && cookies.some((c) => {
        const n = String(c?.name || '').toLowerCase();
        const d = String(c?.domain || '').toLowerCase();
        return (d.includes('viverse.com') || d.includes('htcvive.com')) &&
          (n.includes('session') || n.includes('auth') || n.includes('token') || n.includes('_htc'));
      });
      const loginContextHealthy = !stillOnAccountLogin && !hasSignInUi;
      if (hasSessionCookie && !hasAuthError && loginContextHealthy) {
        result.ok = true;
        result.reason = 'login_success_cookie_present';
      } else if (stillOnAccountLogin && (hasSignInUi || hasRecaptchaUi)) {
        result.reason = 'login_blocked_on_account_signin';
      } else {
        result.reason = hasAuthError ? 'auth_error_text_detected' : 'no_session_cookie';
      }
      result.loginUrl = loginUrl;
      result.bodySnippet = bodyText;
      if (artifactsDir) {
        const loginShot = path.join(artifactsDir, 'login.png');
        const loginLog = path.join(artifactsDir, 'login.log');
        await authPage.screenshot({ path: loginShot, fullPage: true }).catch(() => {});
        await fs.writeFile(
          loginLog,
          [
            `ok=${result.ok}`,
            `reason=${result.reason}`,
            `url=${result.loginUrl || ''}`,
            '',
            'bodySnippet:',
            result.bodySnippet || ''
          ].join('\n'),
          'utf8'
        ).catch(() => {});
        result.artifact_paths = [loginShot, loginLog];
      }
      return result;
    } catch (err) {
      result.reason = String(err?.message || err || 'login_exception');
      return result;
    }
  }

  async _exercisePreviewFlow(page) {
    // Best-effort generic interaction to trigger app auth/matchmaking flows in embedded preview.
    const tryActions = async () => {
      await this._tryClick(page, [
        'button:has-text("CONNECT VIVERSE")',
        'button:has-text("Connect Viverse")',
        'button:has-text("Sign In")',
        'a:has-text("Sign In")'
      ]);
      await page.waitForTimeout(1200);
      await this._tryClick(page, [
        'button:has-text("FIND MATCH")',
        'button:has-text("Find Match")',
        'button:has-text("ENTER BATTLE ARENA")',
        'button:has-text("Enter Battle Arena")',
        'button:has-text("START MATCH")',
        'button:has-text("Start Match")',
        'button:has-text("PLAY")',
        'button:has-text("Play")',
        'button:has-text("JOIN")',
        'button:has-text("Join")',
        'button:has-text("CONTINUE")',
        'button:has-text("Continue")'
      ]);
      await page.waitForTimeout(1200);
    };

    try {
      await page.waitForTimeout(1500);
      await tryActions();
      await tryActions();
    } catch (_) {
      // Non-blocking by design; probe should still capture evidence.
    }
  }

  async _loadPlaywright() {
    try {
      const mod = await import('playwright');
      return mod;
    } catch {
      return null;
    }
  }

  _ensurePageObservers(page) {
    const existing = this._pageObservers.get(page);
    if (existing) return existing;
    const tracked = { consoleLines: [], pageErrors: [] };
    page.on('console', (msg) => {
      tracked.consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      const text = String(err?.message || err || 'unknown page error');
      tracked.pageErrors.push(text);
      tracked.consoleLines.push(`[pageerror] ${text}`);
    });
    this._pageObservers.set(page, tracked);
    return tracked;
  }

  async _capturePageSnapshot(page, label, artifactsDir) {
    const tracked = this._ensurePageObservers(page);
    const consoleLines = tracked.consoleLines;
    const pageErrors = tracked.pageErrors;

    let gotoOk = false;
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 });
      gotoOk = true;
    } catch (_) {
      gotoOk = false;
    }
    await page.waitForTimeout(8000);

    const screenshotPath = path.join(artifactsDir, `${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    const bodyText = await page.evaluate(() => (document?.body?.innerText || '').slice(0, 5000)).catch(() => '');
    const pageUrl = page.url();

    const logPath = path.join(artifactsDir, `${label}.log`);
    const logText = [
      `label=${label}`,
      `url=${pageUrl}`,
      `gotoOk=${gotoOk}`,
      '',
      'console:',
      ...consoleLines,
      '',
      'pageErrors:',
      ...pageErrors,
      '',
      'bodyText:',
      bodyText
    ].join('\n');
    await fs.writeFile(logPath, logText, 'utf8');

    return {
      label,
      gotoOk,
      url: pageUrl,
      screenshotPath,
      logPath,
      console: consoleLines,
      pageErrors,
      bodyText
    };
  }

  async run({ workspacePath, previewUrl, credentials = null }) {
    const playwright = await this._loadPlaywright();
    if (!playwright?.chromium) {
      return {
        status: 'skip',
        reason: 'playwright_not_installed',
        runtime_checks: [
          { name: 'auth_profile', status: 'skip', proof: 'Playwright not installed in runtime environment.' },
          { name: 'matchmaking', status: 'skip', proof: 'Playwright not installed in runtime environment.' }
        ],
        artifact_paths: []
      };
    }

    const stamp = nowStamp();
    const artifactsDir = path.join(workspacePath, 'artifacts', 'preview-tests', `browser-${stamp}`);
    await fs.mkdir(artifactsDir, { recursive: true });
    const authMode = String(process.env.VIVERSE_BROWSER_AUTH_MODE || 'auto').trim().toLowerCase();
    const manualMode = authMode === 'manual';
    const headless = manualMode ? false : !this._boolEnv('VIVERSE_PLAYWRIGHT_HEADFUL', false);
    const loginTimeoutMs = Number(process.env.VIVERSE_BROWSER_MANUAL_LOGIN_TIMEOUT_MS || 180000);
    const storageStatePath = String(
      process.env.VIVERSE_PLAYWRIGHT_STORAGE_STATE ||
      path.join(workspacePath, 'artifacts', 'playwright', 'storage-state.json')
    );
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });

    let browser = null;
    try {
      browser = await playwright.chromium.launch({ headless });

      // Reuse previously captured authenticated session when available.
      const hasStoredState = await this._pathExists(storageStatePath);
      const loginCtx = hasStoredState
        ? await browser.newContext({ storageState: storageStatePath })
        : await browser.newContext();
      const loginPage = await loginCtx.newPage();
      let login = {
        attempted: false,
        ok: false,
        reason: hasStoredState ? 'using_stored_session' : 'not_attempted'
      };

      // First, check if stored/new context is already authenticated in worlds.
      let sessionCheck = await this._verifyWorldsLoggedIn(loginPage);

      if (!sessionCheck.ok && manualMode) {
        logger.info(`BrowserRuntimeTestService: manual auth required. Please sign in in the opened browser window. Timeout ${loginTimeoutMs}ms`);
        login.attempted = true;
        const popupPromise = loginPage.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await this._tryClick(loginPage, [
          'button:has-text("Sign In")',
          'a:has-text("Sign In")',
          'text=Sign In'
        ]);
        const popup = await popupPromise;
        if (popup) {
          await popup.bringToFront().catch(() => {});
        }
        const manual = await this._waitForManualLogin(loginCtx, loginTimeoutMs);
        sessionCheck = manual.ok ? manual : await this._verifyWorldsLoggedIn(loginPage);
        login.ok = !!manual.ok;
        login.reason = manual.reason;
      } else if (!sessionCheck.ok && !manualMode) {
        const autoLogin = await this._loginToViverse(loginPage, credentials, artifactsDir);
        login = { attempted: true, ...autoLogin };
        sessionCheck = await this._verifyWorldsLoggedIn(loginPage);
      }

      const storageState = await loginCtx.storageState().catch(() => null);
      if (sessionCheck.ok && storageState) {
        await fs.writeFile(storageStatePath, JSON.stringify(storageState, null, 2), 'utf8').catch(() => {});
      }
      await loginCtx.close().catch(() => {});

      const contextOpts = storageState ? { storageState } : {};
      const ctxA = await browser.newContext(contextOpts);
      const ctxB = await browser.newContext(contextOpts);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      this._ensurePageObservers(pageA);
      this._ensurePageObservers(pageB);

      await Promise.all([
        pageA.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        pageB.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
      ]);

      await Promise.all([
        this._exercisePreviewFlow(pageA),
        this._exercisePreviewFlow(pageB)
      ]);

      const [snapA, snapB] = await Promise.all([
        this._capturePageSnapshot(pageA, 'host', artifactsDir),
        this._capturePageSnapshot(pageB, 'joiner', artifactsDir)
      ]);

      const derivedA = deriveCheckStatusFromSnapshot(snapA);
      const derivedB = deriveCheckStatusFromSnapshot(snapB);
      const stuckAtAccountLogin =
        isAccountLoginUrl(snapA.url) ||
        isAccountLoginUrl(snapB.url) ||
        !sessionCheck?.ok;
      const authPass = !stuckAtAccountLogin &&
        (derivedA.auth_profile.status === 'pass' || derivedB.auth_profile.status === 'pass');
      const mpPass = derivedA.matchmaking.status === 'pass' || derivedB.matchmaking.status === 'pass';

      const report = {
        generatedAt: new Date().toISOString(),
        preview_url_tested: previewUrl,
        login: {
          attempted: !!login.attempted,
          ok: !!login?.ok,
          reason: login?.reason || 'not_attempted',
          url: login?.loginUrl || null,
          bodySnippet: login?.bodySnippet || null
        },
        authMode,
        storageStatePath,
        sessionCheck,
        host: {
          url: snapA.url,
          gotoOk: snapA.gotoOk,
          pageErrors: snapA.pageErrors
        },
        joiner: {
          url: snapB.url,
          gotoOk: snapB.gotoOk,
          pageErrors: snapB.pageErrors
        },
        derived: {
          host: derivedA,
          joiner: derivedB,
          authPass,
          matchmakingPass: mpPass
        }
      };
      const reportPath = path.join(artifactsDir, 'browser-report.json');
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

      const runtimeChecks = [
        {
          name: 'auth_profile',
          status: authPass ? 'pass' : 'fail',
          proof: authPass
            ? 'At least one browser context reached auth-ready state without critical runtime fault.'
            : stuckAtAccountLogin
              ? `Preview contexts remained on account login or unauthenticated worlds state. sessionCheck=${sessionCheck?.reason || 'unknown'} | ${derivedA.auth_profile.proof} | ${derivedB.auth_profile.proof}`
              : `${derivedA.auth_profile.proof} | ${derivedB.auth_profile.proof}`
        },
        {
          name: 'matchmaking',
          status: mpPass ? 'pass' : 'fail',
          proof: mpPass
            ? 'At least one browser context observed matchmaking room join event.'
            : `${derivedA.matchmaking.proof} | ${derivedB.matchmaking.proof}`
        }
      ];

      return {
        status: authPass && mpPass ? 'pass' : 'fail',
        preview_url_tested: previewUrl,
        runtime_checks: runtimeChecks,
        artifact_paths: [
          reportPath,
          ...(Array.isArray(login?.artifact_paths) ? login.artifact_paths : []),
          snapA.screenshotPath,
          snapA.logPath,
          snapB.screenshotPath,
          snapB.logPath
        ]
      };
    } catch (err) {
      const reason = String(err?.message || err || 'browser_runtime_test_failed');
      logger.warn(`BrowserRuntimeTestService failed: ${reason}`);
      const lower = reason.toLowerCase();
      const infraBlocked =
        lower.includes('permission denied') ||
        lower.includes('mach_port') ||
        lower.includes('bootstrap_check_in') ||
        lower.includes('kill eperm') ||
        lower.includes('target page, context or browser has been closed');
      if (infraBlocked) {
        return {
          status: 'skip',
          reason: 'playwright_launch_blocked',
          runtime_checks: [
            { name: 'auth_profile', status: 'skip', proof: `Playwright launch blocked by runtime environment: ${reason}` },
            { name: 'matchmaking', status: 'skip', proof: `Playwright launch blocked by runtime environment: ${reason}` }
          ],
          artifact_paths: []
        };
      }
      return {
        status: 'fail',
        reason,
        runtime_checks: [
          { name: 'auth_profile', status: 'fail', proof: 'Browser runtime executor failed unexpectedly.' },
          { name: 'matchmaking', status: 'fail', proof: 'Browser runtime executor failed unexpectedly.' }
        ],
        artifact_paths: []
      };
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}

export default new BrowserRuntimeTestService();
