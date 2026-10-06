import { mountBoard } from '../src/view.mjs';
import { emptyBoard } from '../src/board.mjs';
import { mountCodex } from '../src/view-codex.mjs';
import { i18nFor, fmt } from '../src/i18n.mjs';
const envelope = (payload) => ({ ...(payload.ok ? {} : {isError:true}), structuredContent:payload });
const request = async (path,body,signal) => {
  const response = await fetch(path,{method:body?'POST':'GET',signal,headers:{'X-Preview-Token':PREVIEW_TOKEN,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error('Preview request failed');
  return envelope(await response.json());
};
let codex;
const view=mountBoard(document,emptyBoard(),{onOpenAutomations:()=>codex?.openAutomations()??false,onOpenWorkbench:()=>codex?.setVisible(false)??false,refresh:()=>request('/api/board'),mutate:(body)=>request('/api/mutate',body),data:(body)=>request('/api/data',body)});
codex=mountCodex(document,{beforeSurfaceChange:view.prepareSurfaceChange,onSurfaceChange:view.setWorkbenchSurface,onReadState:view.setCodexReadState,pollInManual:true,refresh:({signal})=>request('/api/codex',undefined,signal),onSnapshot:(snapshot)=>view.setCodexSnapshot(snapshot),onReadError:(message)=>view.safeCodexError(message)});
codex.setHostState({connected:true});
const locale = i18nFor(document);
view.setHostState({connected:true,message:fmt(({locale}) => locale === 'zh' ? '交互预览 · 临时数据' : 'Interactive preview · Temporary data')});
const note = document.getElementById('preview-note');
const live = note.textContent.includes('元数据只读');
locale.bindFormatText(note, ({locale}) => locale === 'zh'
  ? live ? '交互预览 · Codex 元数据只读 · 手工记录为临时示例 · 不发送计划请求' : '交互预览 · 临时示例数据 · 不影响现有看板记录'
  : live ? 'Interactive preview · Read-only Codex metadata · Temporary manual records · No plan requests' : 'Interactive preview · Sample data · Existing records are unchanged');
locale.bindFormatText(document.getElementById('preview-theme-label'), ({locale}) => locale === 'zh' ? '预览主题' : 'Preview theme');
for (const [value,zh,en] of [['system','跟随系统','System'],['light','浅色','Light'],['dark','深色','Dark']]) {
  locale.bindFormatText(document.querySelector(`#preview-theme option[value="${value}"]`), ({locale}) => locale === 'zh' ? zh : en);
}
void view.refresh();

document.getElementById("preview-theme").addEventListener("change", (event) => {
  const theme = event.target.value;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
});
