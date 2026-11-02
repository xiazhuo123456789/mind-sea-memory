/* 完整强推：本地工作区 → 全新根提交 → 强推 main（走 GitHub Data API）
 * 用法：GH_TOKEN=xxx node tools/push-v1.cjs  （需 COMMIT_MSG.txt）
 * 注意：本脚本保留在 tools/ 里不再删除——它就是单提交政策的推送工具。 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const REPO = 'repos/xiazhuo123456789/mind-sea-memory';
function ghApi(method, url, jsonBody) {
  const args = ['api'];
  if (method) args.push('-X', method);
  args.push(url);
  const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (jsonBody !== undefined) { args.push('--input', '-'); opts.input = JSON.stringify(jsonBody); }
  return JSON.parse(execFileSync('gh', args, opts));
}

(async () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map(f => f.split('\\').join('/'));
  console.log('文件数:', files.length);

  const tree = [];
  for (const f of files) {
    const b64 = fs.readFileSync(f).toString('base64');
    const blob = ghApi('POST', REPO + '/git/blobs', { content: b64, encoding: 'base64' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }
  console.log('blobs 上传完成');

  const treeRes = ghApi('POST', REPO + '/git/trees', { tree });
  console.log('tree:', treeRes.sha.slice(0, 7));

  const msg = fs.readFileSync('COMMIT_MSG.txt', 'utf8');
  const commit = ghApi('POST', REPO + '/git/commits', { message: msg, tree: treeRes.sha });
  console.log('root commit:', commit.sha.slice(0, 7));

  const ref = ghApi('PATCH', REPO + '/git/refs/heads/main', { sha: commit.sha, force: true });
  console.log('ref 已强推 →', ref.object.sha.slice(0, 7));
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
