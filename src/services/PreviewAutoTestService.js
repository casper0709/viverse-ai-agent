import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import logger from '../utils/logger.js';
import browserRuntimeTestService from './BrowserRuntimeTestService.js';

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensurePreviewUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/preview=1|[?&]preview\b/i.test(raw)) return raw;
  if (/worlds\.viverse\.com\/[A-Za-z0-9_-]+$/i.test(raw)) return `${raw}?preview`;
  return raw;
}

class PreviewAutoTestService {
  extractPreviewUrl(text = '') {
    const body = String(text || '');
    const patterns = [
      /https:\/\/worlds\.viverse\.com\/[A-Za-z0-9_-]+\?preview\b/gi,
      /https:\/\/worlds\.viverse\.com\/[A-Za-z0-9_-]+\?preview=[^ \n\r)]+/gi,
      /https:\/\/worlds\.viverse\.com\/[A-Za-z0-9_-]+\b/gi,
      /https:\/\/world\.viverse\.com\/preview\/[A-Za-z0-9_-]+\b/gi
    ];

    for (const re of patterns) {
      const m = body.match(re);
      if (m && m[0]) return ensurePreviewUrl(m[0]);
    }
    return '';
  }

  async runPreviewProbe({ workspacePath, previewUrl, appId = '', credentials = null }) {
    if (!workspacePath) throw new Error('workspacePath is required');
    const url = ensurePreviewUrl(previewUrl);
    if (!url) {
      return {
        status: 'skip',
        reason: 'missing_preview_url',
        runtime_checks: [
          { name: 'auth_profile', status: 'fail', proof: 'Preview URL missing, cannot probe runtime.' },
          { name: 'matchmaking', status: 'fail', proof: 'Preview URL missing, cannot probe runtime.' }
        ],
        artifact_paths: []
      };
    }

    const artifactsDir = path.join(workspacePath, 'artifacts', 'preview-tests');
    await fs.mkdir(artifactsDir, { recursive: true });
    const stamp = nowStamp();
    const htmlPath = path.join(artifactsDir, `preview-${stamp}.html`);
    const reportPath = path.join(artifactsDir, `preview-${stamp}.json`);

    const findings = [];
    let html = '';
    let statusCode = null;
    let finalUrl = url;
    let reachable = false;
    let networkProbeError = '';

    try {
      const resp = await axios.get(url, {
        maxRedirects: 5,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CodexPreviewProbe/1.0'
        },
        validateStatus: () => true
      });
      statusCode = Number(resp.status || 0);
      html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
      finalUrl = resp?.request?.res?.responseUrl || url;
      reachable = statusCode >= 200 && statusCode < 400;
      findings.push(`HTTP ${statusCode} from preview URL`);
      if (finalUrl && finalUrl !== url) findings.push(`Redirected to ${finalUrl}`);
    } catch (err) {
      networkProbeError = String(err?.message || err || '');
      findings.push(`HTTP probe failed: ${networkProbeError}`);
    }

    const looksLikeWorldShell = /worlds\.viverse\.com|Embedded Content|VIVERSE/i.test(html);
    const mentionsAppId = appId ? html.includes(appId) : false;
    if (looksLikeWorldShell) findings.push('Response appears to be VIVERSE world shell content.');
    if (mentionsAppId) findings.push(`App ID '${appId}' found in HTML shell.`);

    const report = {
      generatedAt: new Date().toISOString(),
      preview_url_tested: url,
      final_url: finalUrl,
      app_id_hint: appId || null,
      http_status: statusCode,
      reachable,
      looks_like_world_shell: looksLikeWorldShell,
      mentions_app_id: mentionsAppId,
      findings
    };

    const htmlSnippet = String(html || '').slice(0, 300000);
    await fs.writeFile(htmlPath, htmlSnippet, 'utf8');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    const probeSkipped = !reachable && !!networkProbeError;

    const runtimeChecks = [
      {
        name: 'auth_profile',
        status: reachable ? 'pass' : (probeSkipped ? 'skip' : 'fail'),
        proof: reachable
          ? `Preview reachable (HTTP ${statusCode}). Full auth/profile runtime still requires browser-session reviewer check.`
          : probeSkipped ? `Preview probe skipped due to network reachability error: ${networkProbeError}` : 'Preview is not reachable.'
      },
      {
        name: 'matchmaking',
        status: reachable ? 'pass' : (probeSkipped ? 'skip' : 'fail'),
        proof: reachable
          ? `Preview reachable (HTTP ${statusCode}). Full matchmaking runtime still requires 2-client reviewer check.`
          : probeSkipped ? `Preview probe skipped due to network reachability error: ${networkProbeError}` : 'Preview is not reachable.'
      }
    ];

    let browserRun = null;
    const browserEnabled = String(process.env.VIVERSE_BROWSER_AUTOTEST || '1') !== '0';
    if (browserEnabled && reachable) {
      const browserProbeTimeoutMs = Math.max(
        30000,
        Number(process.env.VIVERSE_BROWSER_PROBE_TIMEOUT_MS || 90000)
      );
      browserRun = await Promise.race([
        browserRuntimeTestService.run({
          workspacePath,
          previewUrl: url,
          credentials
        }),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              status: 'fail',
              reason: `browser_probe_timeout_${browserProbeTimeoutMs}ms`,
              runtime_checks: [
                {
                  name: 'auth_profile',
                  status: 'fail',
                  proof: `Browser runtime probe timed out after ${browserProbeTimeoutMs}ms`
                },
                {
                  name: 'matchmaking',
                  status: 'fail',
                  proof: `Browser runtime probe timed out after ${browserProbeTimeoutMs}ms`
                }
              ],
              artifact_paths: []
            });
          }, browserProbeTimeoutMs);
        })
      ]);
      const browserArtifacts = Array.isArray(browserRun?.artifact_paths) ? browserRun.artifact_paths : [];
      const browserChecks = Array.isArray(browserRun?.runtime_checks) ? browserRun.runtime_checks : [];
      if (browserArtifacts.length) {
        for (const p of browserArtifacts) {
          if (!report.artifact_paths) report.artifact_paths = [];
          report.artifact_paths.push(p);
        }
      }
      // Prefer browser-derived checks when available (except explicit skip mode).
      if (browserChecks.length && browserRun?.status !== 'skip') {
        for (const bc of browserChecks) {
          const idx = runtimeChecks.findIndex((c) => c.name === bc.name);
          if (idx >= 0) runtimeChecks[idx] = bc;
          else runtimeChecks.push(bc);
        }
      } else if (browserRun?.status === 'skip') {
        // Do not allow HTTP-only reachability to masquerade as full runtime pass
        // when browser runtime execution was skipped/blocked.
        const fallbackChecks = browserChecks.length ? browserChecks : [
          { name: 'auth_profile', status: 'fail', proof: `Browser runtime skipped: ${browserRun?.reason || 'unknown'}` },
          { name: 'matchmaking', status: 'fail', proof: `Browser runtime skipped: ${browserRun?.reason || 'unknown'}` }
        ];
        for (const bc of fallbackChecks) {
          const idx = runtimeChecks.findIndex((c) => c.name === bc.name);
          if (idx >= 0) runtimeChecks[idx] = bc;
          else runtimeChecks.push(bc);
        }
      }
      report.browser_runtime = {
        status: browserRun?.status || 'unknown',
        reason: browserRun?.reason || null
      };
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }

    const artifactPaths = [reportPath, htmlPath];
    if (Array.isArray(browserRun?.artifact_paths)) {
      artifactPaths.push(...browserRun.artifact_paths);
    }
    let overallPass = runtimeChecks.every((c) => c.status === 'pass' || c.status === 'skip');
    if (browserEnabled && reachable && browserRun && browserRun.status !== 'pass') {
      overallPass = false;
    }

    return {
      status: overallPass ? (probeSkipped ? 'skip' : 'pass') : 'fail',
      preview_url_tested: url,
      runtime_checks: runtimeChecks,
      artifact_paths: artifactPaths,
      report
    };
  }
}

export default new PreviewAutoTestService();
