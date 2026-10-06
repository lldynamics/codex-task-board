// Development-only preview: all writes go to a newly created temporary store.
// Never imports or starts src/server.mjs or the production plugin entrypoint.
import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createFileStore } from '../src/store.mjs';
import { LIMITS } from '../src/board.mjs';
import { loadAppTemplate } from './app-template.mjs';
import { previewCodexSnapshot } from './preview-codex-fixtures.mjs';
import { createPreviewDirectory } from './preview-directory.mjs';

const liveCodex = process.argv.includes('--codex-live');
const englishDemo = process.argv.includes('--english-demo');
const sample = (zh, en) => englishDemo ? en : zh;
const codexService = liveCodex ? (await import('../src/codex-service.mjs')).createCodexService() : null;

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await createPreviewDirectory();
const store = createFileStore(directory);
const token = randomBytes(24).toString('hex');
let board = (await store.read()).board;
async function seed(operation) {
  const result = await store.mutate({ requestId: randomUUID(), expectedRevision: board.revision, operation });
  if (!result.ok) throw new Error(result.error.code);
  board = result.board;
}
await seed({type:'save_project',project:{name:sample('产品迭代','Product iteration'),description:sample('把想法推进到完成。这里是临时示例数据，可放心体验拖动与编辑。','Take an idea through to completion. Explore dragging and editing with these temporary sample records.')}});
const projectId = board.projects[0].id;
await seed({type:'save_project',project:{name:sample('学习计划','Learning plan'),description:sample('按自己的节奏学习与复习。','Learn and review at your own pace.')}});
const learningProjectId = board.projects.at(-1).id;
const manualSamples = englishDemo ? [
 ['Review user feedback','planned','Codex','Group this week’s feedback and prioritize the most useful changes.',''],
 ['Improve the empty state','planned','Personal notes','Add a short first-use guide and examples.',''],
 ['Card dragging and ordering','in_progress','Codex','Cross-column moves work; verify ordering and failed saves.',''],
 ['Task detail panel','in_progress','Codex','Finish the form layout and keyboard interactions.',''],
 ['Confirm the new interactions','waiting_user','Codex','The main workflow is ready for review.','Confirm the narrow-window layout'],
 ['Add quick task creation','completed','Codex','Projects and tasks can be created directly.',''],
 ['Explore swimlane grouping','paused','Personal notes','Revisit grouping when the board grows.',''],
 ['Repair an old import sample','failed','Codex','Check the sample fields and import format.','The sample is missing a project ID'],
] : [
 ['整理用户反馈','planned','Codex','归纳这周的反馈，确认优先处理的问题。',''],
 ['优化空状态','planned','个人笔记','补充首次使用的引导与示例说明。',''],
 ['卡片拖动与排序','in_progress','Codex','已完成跨列移动，正在验证排序与保存失败。',''],
 ['任务详情侧栏','in_progress','Codex','完成表单布局，补充键盘操作。',''],
 ['确认新版交互','waiting_user','Codex','主流程已经就绪，等待确认体验。','需要确认窄窗口布局'],
 ['支持快捷新建','completed','Codex','项目和任务都可以直接创建。',''],
 ['探索泳道分组','paused','个人笔记','等任务规模增长后再细化。',''],
 ['修复旧导入样例','failed','Codex','检查样例字段与导入格式。','样例缺少项目标识'],
];
for (const [title,status,sourceTool,currentStep,blocker] of manualSamples) await seed({type:'save_task',task:{projectId,title,status,sourceTool,currentStep,blocker,conversationUrl:null}});
const learningTaskId = randomUUID();
const firstStart = Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000;
await seed({
  type: 'apply_schedule',
  newTasks: [{id: learningTaskId, projectId: learningProjectId, title: sample('用 Python 整理文件','Organize files with Python'), status: 'planned', sourceTool: 'Codex', currentStep: sample('示例目标：了解列表与循环，再写一个文件夹遍历练习。','Sample objective: learn lists and loops, then walk through a folder.'), blocker: '', conversationUrl: null}],
  sessions: [
    {taskId: learningTaskId, startAt: new Date(firstStart).toISOString(), endAt: new Date(firstStart + 30 * 60000).toISOString(), timeZone: 'Asia/Shanghai', objective: sample('学习列表与循环，完成三道小练习。','Learn lists and loops, then complete three small exercises.'), completionCriteria: sample('不看答案，独立完成遍历列表的练习。','Iterate through a list without looking at the solution.')},
    {taskId: learningTaskId, startAt: new Date(firstStart + 45 * 60000).toISOString(), endAt: new Date(firstStart + 75 * 60000).toISOString(), timeZone: 'Asia/Shanghai', objective: sample('编写遍历文件夹的练习。','Write a folder traversal exercise.'), completionCriteria: sample('程序能输出指定目录中的文件名称。','The program prints the names of files in the chosen folder.')},
    {taskId: learningTaskId, startAt: new Date(firstStart + 24 * 3600000).toISOString(), endAt: new Date(firstStart + 24 * 3600000 + 30 * 60000).toISOString(), timeZone: 'Asia/Shanghai', objective: sample('复习昨天的问题，给文件分类。','Review yesterday’s questions and classify files.'), completionCriteria: sample('记录一个已解决的问题与一个待复习的问题。','Record one solved question and one question to revisit.')},
  ],
});
const bundled = await build({ entryPoints:[path.join(root,'scripts/preview-client.mjs')], bundle:true, write:false, format:'iife', platform:'browser', target:'es2022', define:{PREVIEW_TOKEN:JSON.stringify(token)}, minify:true });
const script = bundled.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
let html = await loadAppTemplate(root);
html = html.replace("connect-src 'none'", "connect-src 'self'").replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`);
// Explicit developer-only banner, never included in the production bundle.
html = html.replace('</style>', 'body { height:100dvh; display:flex; flex-direction:column; } body > [role=note] { flex-shrink:0; } .app { height:auto; flex:1; min-height:0; }</style>');
html = html.replace('<body>', '<body><div style="background:#e7efe9;color:#28593e;padding:7px 18px;font:12px system-ui;text-align:center" role="note"><span id="preview-note">交互预览 · 临时示例数据 · 不影响现有看板记录</span> <label style="margin-left:18px"><span id="preview-theme-label">预览主题</span> <select id="preview-theme" style="min-height:26px;padding:2px 5px;font-size:12px;color:#28593e;background:#fff"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>');
if (liveCodex) html = html.replace('交互预览 · 临时示例数据 · 不影响现有看板记录', '交互预览 · Codex 元数据只读 · 手工记录为临时示例 · 不发送计划请求');
const server = createServer(async (req,res) => {
  const respond = (status,payload,type='application/json') => {res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(type==='application/json'?JSON.stringify(payload):payload);};
  // Reject DNS-rebinding requests: only the loopback origin this server printed is served.
  if (req.headers.host!==`127.0.0.1:${server.address().port}`) return respond(421,{error:'Misdirected request'});
  if (req.url==='/' && req.method==='GET') return respond(200,html,'text/html; charset=utf-8');
  if (!req.url?.startsWith('/api/') || req.headers['x-preview-token']!==token) return respond(404,{error:'Not found'});
  if (req.method==='GET' && req.url==='/api/board') return respond(200,await store.read());
  if (req.method==='GET' && req.url==='/api/codex') {
    try { return respond(200,{ok:true,snapshot:codexService ? await codexService.read() : previewCodexSnapshot(undefined, {english:englishDemo})}); }
    catch { return respond(503,{ok:false,error:{code:'SOURCE_UNAVAILABLE',message:'Codex 数据暂时不可用'}}); }
  }
  if (req.method==='POST' && ['/api/mutate','/api/data'].includes(req.url)) {
    if (req.headers.origin!==`http://127.0.0.1:${server.address().port}`) return respond(403,{error:'Origin denied'});
    const chunks=[];let length=0;
    try {
      for await (const chunk of req) {
        length+=chunk.length;
        if(length>LIMITS.bytes*2){respond(413,{error:'Too large'});return;}
        chunks.push(chunk);
      }
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return respond(200,await (req.url==='/api/data'?store.data(input):store.mutate(input)));
    }
    catch {return respond(400,{error:'Invalid request'});}
  }
  return respond(404,{error:'Not found'});
});
server.on('error', (error) => { console.error(`Preview failed: ${error.code || error.message}`); process.exit(1); });
server.listen(0,'127.0.0.1',()=>console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`));
let closing=false;
function shutdown(){ if(closing)return;closing=true;server.closeAllConnections();server.close();process.exit(0); }
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('SIGHUP',shutdown);
