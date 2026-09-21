import { buildSearchIndex, searchLiteral, validateSearch } from './search.js';
import { runRegexSearch } from './search-client.js';
import { buildStudyCards, buildVocabularyQuiz } from './cards.js';

const STORAGE_KEY = 'taiwan-huayu-progress-v1';
const QUIZ_HISTORY_KEY = 'taiwan-huayu-quiz-history-v1';
const PAGE_SIZE = 5;
const $ = selector => document.querySelector(selector);
const state = {
  cards: [], quizData: [], quizHistory: readStore(QUIZ_HISTORY_KEY),
  filtered: [], active: [], index: 0, listPage: 1, flipped: false,
  mode: 'study', view: 'deck', quizGroup: 'all', quizCardIndex: 0,
  query: '', group: 'all', status: 'ALL', progress: readStore(STORAGE_KEY),
  searchIndex: [], searchHits: new Map(), searchMode: 'smart', searchScope: 'all',
  searchError: '', searching: false, shuffle: false
};
let searchRevision = 0, searchController, searchInputTimer;
function readStore(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function saveStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { showToast('Không thể lưu tiến độ trên thiết bị này.'); } }
function escapeHtml(value = '') { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function showToast(message) { const t = $('#toast'); t.textContent = message; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => t.classList.remove('show'), 2200); }
function statusOf(card) { return state.progress[card.senseId] || 'NEW'; }
function badge(card) { const s=statusOf(card), labels={NEW:'○ Chưa học',REVIEW:'◷ Cần ôn',MASTERED:'✓ Đã thuộc'};return `<span class="status ${s}">${labels[s]}</span>`; }

async function boot() {
  try {
    const response = await fetch('./FlastCard/grammar.json');
    if (!response.ok) throw new Error(`Không tải được grammar.json (${response.status})`);
    const source = await response.json();
    state.cards = buildStudyCards(source);
    if (!state.cards.length) throw new Error('Không có thẻ hợp lệ trong database.');
    // This generated file contains vocabulary quiz references, never old JLPT N1 questions.
    try {
      const quizResponse = await fetch('./quiz-data.json');
      state.quizData = quizResponse.ok ? await quizResponse.json() : buildVocabularyQuiz(state.cards);
      if (!Array.isArray(state.quizData) || !state.quizData.length || !('hanVietRef' in state.quizData[0])) {
        state.quizData = buildVocabularyQuiz(state.cards);
      }
    } catch { state.quizData = buildVocabularyQuiz(state.cards); }
    state.searchIndex = buildSearchIndex(state.cards);
    $('#cardCountLabel').textContent = `${state.cards.length} thẻ · ${Object.keys(source.lessons || {}).length} bài học`;
    populateGroups(); populateQuizGroups(); bindEvents(); await applyFilters();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline unavailable:', error));
  } catch (error) {
    console.error('Taiwan Flashcard startup:',error);
    $('#deckView').innerHTML = `<div class="empty"><strong>Không thể tải dữ liệu</strong>Kiểm tra đường dẫn FlastCard/grammar.json và chạy app qua http://localhost (không mở file://).<br><small>${escapeHtml(error.message)}</small></div>`;
  }
}
function updateProgress() {
  const unique = [...new Map(state.cards.map(card => [card.senseId,card])).values()];
  const total=unique.length, mastered=unique.filter(c=>statusOf(c)==='MASTERED').length, review=unique.filter(c=>statusOf(c)==='REVIEW').length;
  const percent=total?Math.round(mastered*100/total):0;
  $('#masteredCount').textContent=mastered;$('#reviewCount').textContent=review;
  $('#newCount').textContent=Math.max(0,total-mastered-review);
  $('#progressText').textContent=`${mastered} / ${total} · ${percent}%`;
  $('#progressValue').style.width=`${percent}%`;
}
function populateGroups() {
  const groups=[...new Map(state.cards.map(card=>[card.group,card.groupName])).entries()];
  $('#groupSelect').innerHTML='<option value="all">▦ Tất cả bài học</option>'+groups.map(([id,label])=>`<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
}
function populateQuizGroups() {
  const groups=[...new Set(state.quizData.map(x=>x.category))];
  $('#quizGroupSelect').innerHTML='<option value="all">▦ Tất cả bài học</option>'+groups.map(g=>`<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
}
function quizItems() { return state.quizData.filter(x=>state.quizGroup==='all'||x.category===state.quizGroup); }
function populateQuizCards() {
  const items=quizItems();state.quizCardIndex=Math.min(state.quizCardIndex,Math.max(0,items.length-1));
  $('#quizCardSelect').innerHTML=items.map((x,i)=>`<option value="${i}">${String(i+1).padStart(2,'0')}. ${escapeHtml(x.title)}</option>`).join('');
  $('#quizCardSelect').value=String(state.quizCardIndex);
}
function currentQuizItem() { return quizItems()[state.quizCardIndex]; }
function isDue(entry) { return !entry?.nextReviewAt || Date.parse(entry.nextReviewAt)<=Date.now(); }
function updateAdaptiveStatus() { $('#adaptiveQuizStatus').textContent=`${state.quizData.filter(x=>isDue(state.quizHistory[x.id])).length} từ đến hạn`; }
function renderQuizHistory(item) {
  const history=state.quizHistory[item.id], summary=$('#quizHistorySummary'), panel=$('#quizHistoryPanel');
  if(!history){summary.textContent='Chưa có lịch sử kiểm tra từ này.';panel.hidden=true;return;}
  summary.textContent=`Đã kiểm tra ${history.attempts} lần · ${history.lastRating==='known'?'Đã thuộc':'Chưa thuộc'}`;
  panel.hidden=false;panel.innerHTML=`<h3>Lịch sử kiểm tra</h3><p>Gần nhất: ${escapeHtml(new Date(history.lastAttemptAt).toLocaleString('vi-VN'))}</p>`;
}
function renderQuiz() {
  populateQuizCards();const item=currentQuizItem();if(!item)return;
  $('#quizGroupSelect').value=state.quizGroup;$('#quizTarget').textContent=item.title;
  $('#quizExampleField').hidden=!item.exampleRef;
  renderQuizHistory(item);updateAdaptiveStatus();
}
function resetQuiz() { $('#quizForm').reset();$('#quizResult').hidden=true;renderQuiz(); }
function chooseAdaptiveQuiz() {
  const due=state.quizData.filter(x=>isDue(state.quizHistory[x.id]));
  if(!due.length)return showToast('Chưa có từ đến hạn ôn.');
  const selected=due[0];state.quizGroup='all';state.quizCardIndex=state.quizData.indexOf(selected);resetQuiz();
}
function evaluateQuiz(event) {
  event.preventDefault();const item=currentQuizItem();if(!item)return;
  const pairs=[['Nghĩa tiếng Việt',$('#quizMeaning').value,item.meaningRef],['Âm Hán Việt',$('#quizHanViet').value,item.hanVietRef],['Từ loại',$('#quizPos').value,item.posRef],['Phân tích chữ',$('#quizChars').value,item.charsRef]];
  if(item.exampleRef)pairs.push(['Câu ví dụ',$('#quizExample').value,item.exampleRef]);
  const result=$('#quizResult');result.hidden=false;
  result.innerHTML=`<h3>Đối chiếu đáp án</h3><p class="muted">Kiểm tra thủ công: cách diễn đạt đúng có thể khác đáp án tham khảo.</p>${pairs.map(([name,answer,expected])=>`<div class="quiz-feedback"><strong>${escapeHtml(name)}</strong><div>Bạn trả lời: ${escapeHtml(answer)||'—'}</div><em>Tham khảo: ${escapeHtml(expected)||'Chưa có dữ liệu'}</em></div>`).join('')}<div class="back-actions"><button data-quiz-rating="unknown">✕ Chưa thuộc</button><button data-quiz-rating="known">✓ Đã thuộc</button></div>`;
  result.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function rateQuiz(value) {
  const item=currentQuizItem();if(!item)return;
  const old=state.quizHistory[item.id], now=Date.now(), success=value==='known';
  const days=success?Math.min(30,[1,3,7,14,30][Math.min(old?.repetitions||0,4)]):0;
  state.quizHistory[item.id]={attempts:(old?.attempts||0)+1,lastRating:value,
    repetitions:success?(old?.repetitions||0)+1:0,lastAttemptAt:new Date(now).toISOString(),
    nextReviewAt:new Date(now+days*86400000).toISOString()};
  saveStore(QUIZ_HISTORY_KEY,state.quizHistory);renderQuizHistory(item);updateAdaptiveStatus();
  showToast(success?'Đã ghi nhận: Đã thuộc':'Đã ghi nhận: Chưa thuộc');
}
function cancelSearch(){searchRevision++;searchController?.abort();searchController=undefined;}
function updateSearchHelp() {
  const help={smart:'Tìm chữ phồn thể, Zhuyin, Pinyin, âm Hán Việt hoặc nghĩa tiếng Việt (có thể không dấu).',
    phrase:'Tìm một cụm ký tự theo đúng thứ tự.',regex:'Regex Unicode, ví dụ: 學|校'};
  $('#searchHelp').textContent=help[state.searchMode];
  $('#searchInput').placeholder=state.searchMode==='regex'?'Ví dụ: 學|校':'Nhập chữ Hán, Pinyin, Zhuyin hoặc nghĩa…';
  $('#searchError').textContent=state.searchError;$('#searchError').hidden=!state.searchError;
  $('#searchInput').setAttribute('aria-invalid',String(!!state.searchError));
  $('#deckView').setAttribute('aria-busy',String(state.searching));$('#listView').setAttribute('aria-busy',String(state.searching));
}
function searchEmptyTemplate(){
  if(state.searching)return '<div class="empty"><strong>Đang tìm kiếm…</strong></div>';
  if(state.searchError)return '<div class="empty"><strong>Chưa có kết quả</strong>Kiểm tra biểu thức và thử lại.</div>';
  return '<div class="empty"><strong>Không tìm thấy thẻ phù hợp</strong>Thử thay đổi từ khóa hoặc bộ lọc.</div>';
}
function matchLabel(card) {const hit=state.searchHits.get(card.id);return hit?.matchLabel?`<span class="search-match">Khớp: ${escapeHtml(hit.matchLabel)}</span>`:'';}
async function applyFilters({preserveId=null}={}) {
  clearTimeout(searchInputTimer);cancelSearch();const revision=searchRevision;
  state.searchError='';state.searchHits=new Map();state.listPage=1;
  if(!preserveId){state.index=0;state.flipped=false;}
  const eligible=new Map(state.cards.filter(c=>(state.group==='all'||c.group===state.group)&&(state.status==='ALL'||statusOf(c)===state.status)).map(c=>[c.id,c]));
  const index=state.searchIndex.filter(doc=>eligible.has(doc.id));
  try {
    let hits;
    if(state.searchMode==='regex'&&state.query.trim()){
      state.searching=true;state.filtered=[];state.active=[];updateSearchHelp();render();
      searchController=new AbortController();hits=await runRegexSearch(index,state.query,state.searchScope,{signal:searchController.signal});
    }else hits=searchLiteral(index,state.query,{mode:state.searchMode==='regex'?'smart':state.searchMode,scope:state.searchScope});
    if(revision!==searchRevision)return;
    state.searchHits=new Map(hits.map(hit=>[hit.id,hit]));
    state.filtered=hits.map(hit=>eligible.get(hit.id));
    if(state.shuffle)state.filtered.sort(()=>Math.random()-.5);
  }catch(error){if(revision!==searchRevision||error.name==='AbortError')return;state.searchError=error.message;state.filtered=[];}
  finally{if(revision===searchRevision){state.searching=false;state.active=state.filtered;
    if(preserveId){const position=state.active.findIndex(c=>c.id===preserveId);state.index=position>=0?position:Math.min(state.index,Math.max(0,state.active.length-1));if(position<0)state.flipped=false;}
    updateSearchHelp();render();}}
}
function render() {
  const study=state.mode==='study';$('#progressPanel').hidden=!study;$('#controlsPanel').hidden=!study;
  $('#deckView').hidden=!study||state.view!=='deck';$('#listView').hidden=!study||state.view!=='list';$('#quizView').hidden=study;
  if(study){updateProgress();$('#resultCount').textContent=state.searching?'Đang tìm…':`${state.filtered.length} thẻ`;
    document.querySelectorAll('[data-view]').forEach(button=>{button.classList.toggle('active',button.dataset.view===state.view);button.setAttribute('aria-selected',String(button.dataset.view===state.view));});
    state.view==='deck'?renderDeck():renderList();}else renderQuiz();
}
function charTemplate(part) {
  return `<div class="hanzi-part"><strong lang="zh-Hant">${escapeHtml(part.character)}</strong><b>${escapeHtml(part.hanViet)||'—'}</b>${part.contextMeaning?`<small>${escapeHtml(part.contextMeaning)}</small>`:''}</div>`;
}
function frontTemplate(card) {
  return `<article class="card vocab-card" data-action="flip" role="button" tabindex="0" aria-label="Chạm để xem mặt sau">
    <div class="card-face"><div class="card-label"><span>MẶT TRƯỚC · NHẬN DIỆN</span><span class="group">${escapeHtml(card.section)}</span></div>
    <div class="card-front-content"><h2 lang="zh-Hant">${escapeHtml(card.front)}</h2>
    <span class="hint">Chạm vào thẻ để xem đáp án</span></div>
    <div class="card-footer">${badge(card)}<span class="group">${escapeHtml(card.groupName)}</span></div></div></article>`;
}
function backTemplate(card) {
  const characterBox=card.characters.length?`<div class="vocab-section-label">PHÂN TÍCH CHỮ HÁN</div><div class="hanzi-parts">${card.characters.map(charTemplate).join('')}</div>`:'';
  const measure=card.measureWords.length?` · Lượng từ: ${escapeHtml(card.measureWords.join(', '))}`:'';
  const relations=card.related.slice(0,2).map(x=>`${escapeHtml(x.word)} — ${escapeHtml(x.meaning)}`).join(' · ');
  const relatedBox=relations?`<div class="vocab-section-label">TỪ LIÊN QUAN</div><p class="vocab-related">${relations}</p>`:'';
  const example=card.examples[0];
  const exampleBox=example?`<div class="vocab-section-label">VÍ DỤ</div><div class="vocab-example"><b lang="zh-Hant">${escapeHtml(example.traditional)}</b>${example.zhuyin?`<small>${escapeHtml(example.zhuyin)}</small>`:''}${example.pinyin?`<small>${escapeHtml(example.pinyin)}</small>`:''}<p>${escapeHtml(example.meaning_vi||'')}</p></div>`:'';
  return `<article class="card vocab-card" data-action="flip" role="button" tabindex="0" aria-label="Chạm để quay lại mặt trước"><div class="card-face">
    <div class="card-label"><span>MẶT SAU · KIẾN THỨC</span><span class="group">${escapeHtml(card.section)}</span></div>
    <div class="back-content vocab-back"><div class="vocab-back-head"><h2 lang="zh-Hant">${escapeHtml(card.front)}</h2>
    <div class="vocab-reading" lang="zh-Bopo">${escapeHtml(card.zhuyin)}</div>
    <div class="vocab-pinyin">${escapeHtml(card.pinyin)}</div>
    <strong>${escapeHtml(card.meaning)}</strong>
    <p>Âm Hán Việt: ${escapeHtml(card.hanViet)||'—'} · ${escapeHtml(card.pos.join(', ')||'Chưa phân loại')}${measure}</p></div>
    ${characterBox}${relatedBox}${exampleBox}${card.usage?`<details class="vocab-extra"><summary>Xem thêm · Cách dùng</summary><p>${escapeHtml(card.usage)}</p></details>`:''}
    <div class="vocab-return">Chạm vào thẻ để quay lại</div></div>
    <div class="card-footer">${badge(card)}<span class="group">${escapeHtml(card.groupName)}</span></div>
    </div></article>`;
}
function renderDeck() {
  const card=state.active[state.index];if(!card){$('#deckView').innerHTML=searchEmptyTemplate();return;}
  const example=card.examples[0];
  const playButton=(!state.flipped||example)?`<button class="vocab-audio" type="button" data-action="${state.flipped?'speak-example':'speak-front'}">🔊 &nbsp; Nghe ${state.flipped?'câu ví dụ':'từ vựng'}</button>`:'';
  const rating=`<div class="vocab-ratings"><button type="button" class="vocab-unknown ${statusOf(card)==='REVIEW'?'selected':''}" data-action="review">✕ &nbsp; Chưa thuộc</button><button type="button" class="vocab-known ${statusOf(card)==='MASTERED'?'selected':''}" data-action="mastered">✓ &nbsp; Đã thuộc</button></div>`;
  $('#deckView').innerHTML=`<div class="deck-top"><span>Thẻ ${state.index+1} / ${state.active.length}</span>${matchLabel(card)}${badge(card)}</div>
    ${state.flipped?backTemplate(card):frontTemplate(card)}${playButton}${rating}<div class="deck-actions"><button data-action="previous">← &nbsp; Trước</button><button data-action="next">Tiếp &nbsp; →</button></div>`;
}
function renderList() {
  const pages=Math.max(1,Math.ceil(state.filtered.length/PAGE_SIZE));state.listPage=Math.min(state.listPage,pages);
  const start=(state.listPage-1)*PAGE_SIZE, items=state.filtered.slice(start,start+PAGE_SIZE);
  const body=items.map(card=>`<button class="list-item" data-card="${escapeHtml(card.id)}"><span><strong lang="zh-Hant">${escapeHtml(card.front)}</strong><p>${escapeHtml(card.zhuyin)} · ${escapeHtml(card.pinyin)}</p><p>${escapeHtml(card.meaning)}</p>${matchLabel(card)}</span>${badge(card)}</button>`).join('');
  const pagination=state.filtered.length?`<div class="pagination"><button data-page="first" ${state.listPage===1?'disabled':''}>« Đầu</button><button data-page="previous" ${state.listPage===1?'disabled':''}>← Trước</button><span>Trang ${state.listPage} / ${pages}</span><button data-page="next" ${state.listPage===pages?'disabled':''}>Sau →</button><button data-page="last" ${state.listPage===pages?'disabled':''}>Cuối »</button></div>`:'';
  $('#listView').innerHTML=`<h2>DANH SÁCH TỪ VỰNG</h2>${state.filtered.length?body+pagination:searchEmptyTemplate()}`;
}
function speak(text,audioUrl=null) {
  if(audioUrl) {
    if(!speak.player)speak.player=new Audio();
    speak.player.pause();speak.player.src=audioUrl;speak.player.play().catch(()=>showToast('Không thể phát file âm thanh.'));
    return;
  }
  if(!text)return;
  if(!('speechSynthesis' in window))return showToast('Thiết bị không hỗ trợ giọng đọc.');
  speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='zh-TW';utterance.rate=.85;
  const voices=speechSynthesis.getVoices();utterance.voice=voices.find(v=>v.lang.toLowerCase().replace('_','-')==='zh-tw')||voices.find(v=>v.lang.toLowerCase().startsWith('zh'))||null;
  speechSynthesis.speak(utterance);
}
async function setStatus(status) {
  const card=state.active[state.index];if(!card)return;
  state.progress[card.senseId]=status;saveStore(STORAGE_KEY,state.progress);
  await applyFilters({preserveId:card.id});
  showToast(status==='MASTERED'?'Đã đánh dấu: Đã thuộc':'Đã đánh dấu: Chưa thuộc');
}
function bindEvents() {
  let composing=false;
  const schedule=()=>{state.query=$('#searchInput').value;$('#clearSearch').hidden=!state.query;clearTimeout(searchInputTimer);cancelSearch();searchInputTimer=setTimeout(()=>applyFilters(),120);};
  $('#searchInput').addEventListener('compositionstart',()=>{composing=true;clearTimeout(searchInputTimer);cancelSearch();});
  $('#searchInput').addEventListener('compositionend',()=>{composing=false;schedule();});
  $('#searchInput').addEventListener('input',e=>{if(!composing&&!e.isComposing)schedule();});
  $('#clearSearch').addEventListener('click',()=>{$('#searchInput').value='';state.query='';$('#clearSearch').hidden=true;applyFilters();$('#searchInput').focus();});
  $('#searchMode').addEventListener('change',e=>{state.searchMode=e.target.value;updateSearchHelp();applyFilters();});
  $('#searchScope').addEventListener('change',e=>{state.searchScope=e.target.value;applyFilters();});
  $('#groupSelect').addEventListener('change',e=>{state.group=e.target.value;applyFilters();});
  $('#statusSelect').addEventListener('change',e=>{state.status=e.target.value;applyFilters();});
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{state.view=button.dataset.view;render();}));
  $('#menuButton').addEventListener('click',()=>{$('#menu').hidden=!$('#menu').hidden;});
  $('#studyModeButton').addEventListener('click',()=>{state.mode='study';$('#menu').hidden=true;render();});
  $('#testModeButton').addEventListener('click',()=>{state.mode='test';$('#menu').hidden=true;resetQuiz();render();});
  $('#shuffleButton').addEventListener('click',()=>{state.shuffle=!state.shuffle;state.active=[...state.filtered];if(state.shuffle)state.active.sort(()=>Math.random()-.5);state.index=0;state.flipped=false;$('#menu').hidden=true;render();showToast(state.shuffle?'Đã bật xáo trộn':'Đã tắt xáo trộn');});
  $('#resetButton').addEventListener('click',()=>{if(!confirm('Đặt lại toàn bộ tiến độ học tiếng Trung?'))return;state.progress={};saveStore(STORAGE_KEY,state.progress);$('#menu').hidden=true;applyFilters();});
  $('#deckView').addEventListener('click',e=>{
    if(e.target.closest('details'))return;
    const action=e.target.closest('[data-action]')?.dataset.action;
    if(!action||!state.active.length)return;
    if(action==='flip'){state.flipped=!state.flipped;renderDeck();}
    else if(action==='next'||action==='previous'){state.index=(state.index+(action==='next'?1:-1)+state.active.length)%state.active.length;state.flipped=false;renderDeck();}
    else if(action==='review'||action==='mastered')setStatus(action==='review'?'REVIEW':'MASTERED');
    else if(action==='speak-front'){const c=state.active[state.index];speak(c.ttsOverride||c.front,c.audioUrl);}
    else if(action==='speak-example'){const e=state.active[state.index].examples[0];if(e)speak(e.traditional,e.audio_url);}
  });
  $('#deckView').addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.vocab-card')){e.preventDefault();state.flipped=!state.flipped;renderDeck();}});
  $('#listView').addEventListener('click',e=>{
    const page=e.target.closest('[data-page]');if(page&&!page.disabled){const total=Math.max(1,Math.ceil(state.filtered.length/PAGE_SIZE));
      state.listPage=page.dataset.page==='first'?1:page.dataset.page==='last'?total:state.listPage+(page.dataset.page==='next'?1:-1);renderList();return;}
    const button=e.target.closest('[data-card]');if(!button)return;const index=state.active.findIndex(c=>c.id===button.dataset.card);
    if(index>=0){state.index=index;state.flipped=false;state.view='deck';render();}
  });
  $('#adaptiveQuizButton').addEventListener('click',chooseAdaptiveQuiz);
  $('#quizGroupSelect').addEventListener('change',e=>{state.quizGroup=e.target.value;state.quizCardIndex=0;resetQuiz();});
  $('#quizCardSelect').addEventListener('change',e=>{state.quizCardIndex=Number(e.target.value);resetQuiz();});
  $('#quizForm').addEventListener('submit',evaluateQuiz);
  $('#quizResult').addEventListener('click',e=>{const rating=e.target.closest('[data-quiz-rating]')?.dataset.quizRating;if(rating)rateQuiz(rating);});
}
boot();