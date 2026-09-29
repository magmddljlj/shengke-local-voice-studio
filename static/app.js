const $ = (id) => document.getElementById(id);
let profiles = [];
let readingScript = $('reading-script').textContent.trim();
const readingScripts = [
  readingScript,
  '我刚才下楼取快递，顺便买了瓶水。今天路上人不多，走过来还挺快的。',
  '刚泡了杯茶，放了一会儿才想起来喝。最近事情有点多，得一件一件慢慢来。',
  '今天早上出门比较早，路边早餐店刚开门。我买了个包子，边走边吃就到公司了。',
  '这个袋子先放桌上吧，等会儿收拾的时候再一起拿走。你看一下，还有东西落下吗？',
  '我把窗户打开透透气，屋里一下就凉快多了。外面风不大，今天还挺舒服的。',
  '刚收到一条消息，说会议往后推了半小时。这样也好，我正好先把手上的事做完。',
  '那家店我以前去过，东西不贵，离这儿也不远。你要是有空，咱们可以过去看看。',
  '钥匙在门口的小盒子里，充电器应该还在书桌旁边。出门前再检查一遍就行。',
];
let recordedFile = null;
let recordingUrl = null;
let recorder = null;
let recordingStream = null;
let recordingStartedAt = 0;
let recordingTimer = null;
let holding = false;
let starting = false;
let finalizing = false;
let outputsExpanded = false;

document.addEventListener('play', (event) => {
  if (!(event.target instanceof HTMLAudioElement)) return;
  document.querySelectorAll('audio').forEach((audio) => {
    if (audio !== event.target) audio.pause();
  });
}, true);

async function request(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error('本地声音服务没有连接。请双击“启动声刻.command”启动服务，再刷新页面。'); }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.detail || `请求失败（${response.status}）`);
  return data;
}

function message(id, value, error = false) {
  const node = $(id);
  node.textContent = value;
  node.classList.toggle('error', error);
}

async function loadOutputs() {
  try {
    const outputs = await request('/api/outputs');
    const list = $('output-list');
    list.querySelectorAll('audio').forEach((audio) => audio.pause());
    list.replaceChildren();
    $('output-total').textContent = `${outputs.length} 条`;
    $('result').classList.toggle('hidden', outputs.length === 0);
    if (outputs.length <= 5) outputsExpanded = false;
    const toggle = $('output-toggle');
    toggle.classList.toggle('hidden', outputs.length <= 5);
    toggle.textContent = outputsExpanded ? '收起旧记录 ↑' : `展开其余 ${outputs.length - 5} 条 ↓`;
    toggle.setAttribute('aria-expanded', String(outputsExpanded));
    for (const output of (outputsExpanded ? outputs : outputs.slice(0, 5))) {
      const card = document.createElement('article'); card.className = 'output-card';
      const head = document.createElement('div'); head.className = 'output-head';
      const title = document.createElement('strong');
      const engineName = output.engine === 'omnivoice' ? 'OmniVoice' : output.engine === 'qwen' ? '千问 3 TTS' : '模型信息缺失';
      title.textContent = `${output.voice_name || '音色'} · ${engineName}`;
      const time = document.createElement('small');
      time.textContent = new Date(output.created_at * 1000).toLocaleString('zh-CN');
      head.append(title, time);
      const script = document.createElement('p'); script.className = 'output-script'; script.textContent = output.text;
      const player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = output.url;
      const actions = document.createElement('div'); actions.className = 'output-actions';
      const download = document.createElement('a'); download.href = output.url; download.download = output.filename; download.textContent = '下载 MP3 ↓';
      actions.append(download);
      let referenceDetails = null;
      if (profiles.some((profile) => profile.id === output.voice_id)) {
        referenceDetails = document.createElement('details'); referenceDetails.className = 'reference-details';
        const summary = document.createElement('summary'); summary.textContent = '对照原声';
        const referenceAudio = document.createElement('audio'); referenceAudio.controls = true; referenceAudio.preload = 'metadata'; referenceAudio.src = `/api/voices/${output.voice_id}/reference`;
        referenceAudio.setAttribute('aria-label', `${output.voice_name || '音色'}的原录音`);
        referenceDetails.append(summary, referenceAudio);
        referenceDetails.addEventListener('toggle', () => { if (!referenceDetails.open) referenceAudio.pause(); });
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'output-delete'; remove.textContent = '删除';
      remove.onclick = async () => {
        if (!confirm(`删除这条“${output.voice_name || '音色'}”生成记录及本机 MP3？删除后无法恢复。`)) return;
        try { await request(`/api/outputs/${output.id}`, { method: 'DELETE' }); await loadOutputs(); message('generate-message', '这条生成记录已删除。'); }
        catch (error) { message('generate-message', error.message, true); }
      };
      actions.append(remove);
      const check = document.createElement('small'); check.className = 'output-check';
      check.textContent = output.engine === 'unknown' ? '音频文件已找回；原文、音色和模型信息没有保存' : output.verified ? '✓ MP3 文件校验通过 · 请试听判断音色和读字' : '请试听判断音色和读字';
      card.append(head, script, player, actions);
      if (referenceDetails) card.append(referenceDetails);
      card.append(check); list.append(card);
    }
  }
  catch (error) { message('generate-message', error.message, true); }
}

$('output-toggle').onclick = () => { outputsExpanded = !outputsExpanded; loadOutputs(); };

$('change-reading').onclick = () => {
  const previous = readingScript;
  const choices = readingScripts.filter((text) => text !== previous);
  readingScript = choices[Math.floor(Math.random() * choices.length)];
  $('reading-script').textContent = readingScript;
  if (!$('transcript').value.trim() || $('transcript').value.trim() === previous) $('transcript').value = readingScript;
  $('reading-message').textContent = '已换一段日常文案；如实际读法不同，请按录音修改原文。';
};

async function refresh() {
  try {
    profiles = await request('/api/voices');
    const selected = $('voice-select').value;
    $('voice-select').replaceChildren();
    const initial = new Option(profiles.length ? '请选择音色' : '请先添加音色', '');
    $('voice-select').add(initial);
    for (const profile of profiles) $('voice-select').add(new Option(`${profile.name} · ${profile.duration} 秒`, profile.id));
    if (profiles.some((p) => p.id === selected)) $('voice-select').value = selected;
    else if (profiles.length === 1) $('voice-select').value = profiles[0].id;
    $('voice-total').textContent = profiles.length;
    const list = $('voice-list');
    list.querySelectorAll('audio').forEach((audio) => audio.pause());
    list.replaceChildren();
    if (!profiles.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '还没有音色。先添加一段参考录音。'; list.append(empty); }
    for (const profile of profiles) {
      const item = document.createElement('div'); item.className = 'voice-item';
      const info = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = profile.name;
      const detail = document.createElement('small'); detail.textContent = `${profile.duration} 秒参考录音`;
      info.append(title, detail);
      const preview = document.createElement('audio'); preview.controls = true; preview.preload = 'metadata'; preview.src = `/api/voices/${profile.id}/reference`;
      preview.setAttribute('aria-label', `${profile.name}的原录音`);
      const remove = document.createElement('button'); remove.textContent = '删除'; remove.title = `删除${profile.name}`;
      remove.onclick = async () => { if (!confirm(`删除音色“${profile.name}”？`)) return; try { await request(`/api/voices/${profile.id}`, { method: 'DELETE' }); await refresh(); } catch (e) { message('voice-message', e.message, true); } };
      const actions = document.createElement('div'); actions.className = 'voice-actions'; actions.append(remove);
      const head = document.createElement('div'); head.className = 'voice-item-head'; head.append(info, actions);
      item.append(head, preview); list.append(item);
    }
  } catch (error) { message('voice-message', error.message, true); }
}

function clearRecording() {
  recordedFile = null;
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = null;
  $('record-preview').pause();
  $('record-preview').removeAttribute('src');
  $('record-preview').classList.add('hidden');
}

function stopRecording() {
  if (recorder?.state === 'recording') { finalizing = true; recorder.stop(); }
  clearTimeout(recordingTimer);
  $('audio').disabled = false;
  $('record-toggle').dataset.active = 'false';
  $('record-hold').classList.remove('is-recording');
  $('record-hold').textContent = '● 按住说话';
  $('record-toggle').textContent = '或点按开始录音';
}

async function startRecording() {
  if (starting || finalizing || recorder?.state === 'recording') return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('record-message').textContent = '这个页面无法使用麦克风。手机需要通过 HTTPS 打开；也可以上传已有录音。';
    return;
  }
  starting = true;
  $('record-message').textContent = '正在请求麦克风权限…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (!holding && $('record-toggle').dataset.active !== 'true') {
      stream.getTracks().forEach((track) => track.stop());
      $('record-message').textContent = '麦克风已允许，请再按住录音；也可以点按开始。';
      return;
    }
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported?.(type));
    recordingStream = stream;
    const currentRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder = currentRecorder;
    const chunks = [];
    let failed = false;
    currentRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    currentRecorder.onerror = () => { failed = true; stopRecording(); };
    currentRecorder.onstop = () => {
      finalizing = false;
      stream.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      const duration = (Date.now() - recordingStartedAt) / 1000;
      if (failed || duration < 3 || !chunks.length) {
        $('record-message').textContent = failed ? '录音中断，请重新录制。' : '录音至少需要 3 秒，请重新读一遍。';
        return;
      }
      clearRecording();
      const type = currentRecorder.mimeType || chunks[0].type || 'audio/mp4';
      const extension = type.includes('webm') ? 'webm' : 'm4a';
      recordedFile = new File(chunks, `声刻录音.${extension}`, { type });
      recordingUrl = URL.createObjectURL(recordedFile);
      $('record-preview').src = recordingUrl;
      $('record-preview').classList.remove('hidden');
      $('transcript').value ||= readingScript;
      $('record-message').textContent = `录好了（${Math.min(duration, 15).toFixed(1)} 秒）。试听后填写音色名称并保存；如果读错了字，请修改录音原文。`;
    };
    currentRecorder.start();
    clearRecording();
    recordingStartedAt = Date.now();
    $('audio').value = '';
    $('audio').disabled = true;
    $('file-label').textContent = '点击选择 MP4、MOV、WAV、MP3 或 M4A';
    $('transcript').value ||= readingScript;
    $('record-hold').classList.add('is-recording');
    $('record-hold').textContent = '● 正在录音，松开结束';
    $('record-toggle').textContent = '点按结束录音';
    $('record-message').textContent = '正在录音，请朗读上面的正文…';
    recordingTimer = setTimeout(stopRecording, 15000);
  } catch (error) {
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    $('record-toggle').dataset.active = 'false';
    $('record-message').textContent = error.name === 'NotAllowedError' ? '麦克风未获允许。请在浏览器中允许使用麦克风，或上传录音。' : '无法启动麦克风，请检查设备或改用文件上传。';
  } finally { starting = false; }
}

$('record-hold').addEventListener('pointerdown', (event) => {
  if (!event.isPrimary) return;
  event.preventDefault();
  holding = true;
  $('record-hold').setPointerCapture?.(event.pointerId);
  startRecording();
});
$('record-hold').addEventListener('pointerup', () => { holding = false; stopRecording(); });
$('record-hold').addEventListener('pointercancel', () => { holding = false; stopRecording(); });
$('record-toggle').onclick = () => {
  if (finalizing) return;
  if (starting) { $('record-toggle').dataset.active = 'false'; $('record-message').textContent = '已取消录音。'; return; }
  if (recorder?.state === 'recording') { $('record-toggle').dataset.active = 'false'; stopRecording(); }
  else { $('record-toggle').dataset.active = 'true'; startRecording(); }
};
$('audio').addEventListener('change', () => {
  $('file-label').textContent = $('audio').files[0]?.name || '点击选择 MP4、MOV、WAV、MP3 或 M4A';
  if ($('audio').files.length) { clearRecording(); $('record-message').textContent = '已选择上传文件；如需改为直接录音，请重新按住录音。'; }
});
$('script').addEventListener('input', () => { $('count').textContent = `${$('script').value.length} / 500`; });
$('refresh').onclick = refresh;
$('copy-reading').onclick = async () => {
  const message = `请在安静的地方，用平常说话的语气，只朗读下面这段文字。读完停一秒；不要加背景音乐，也不用念这段说明。\n\n${readingScript}`;
  try { await navigator.clipboard.writeText(message); $('reading-message').textContent = '已复制，可以发给朗读者。'; }
  catch { $('reading-message').textContent = '复制失败，请手动选择上面的正文。'; }
};
$('fill-transcript').onclick = () => {
  $('transcript').value = readingScript;
  $('transcript').focus();
  $('reading-message').textContent = '已填入录音原文；如实际读法不同，请修改。';
};

$('voice-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (starting || finalizing || recorder?.state === 'recording') { message('voice-message', '请先结束录音。', true); return; }
  if (!$('audio').files.length && !recordedFile) { message('voice-message', '请先直接录音，或选择已有录音、视频。', true); return; }
  const button = event.submitter; button.disabled = true;
  message('voice-message', '正在检查并保存录音…');
  try {
    const body = new FormData(form);
    if (recordedFile) body.set('audio', recordedFile);
    const profile = await request('/api/voices', { method: 'POST', body });
    form.reset(); clearRecording(); $('file-label').textContent = '点击选择 MP4、MOV、WAV、MP3 或 M4A';
    $('record-message').textContent = '录完可试听，再点“保存这个音色”。';
    await refresh(); $('voice-select').value = profile.id;
    message('voice-message', '音色已保存，现在可以生成配音。');
  } catch (error) { message('voice-message', error.message, true); }
  finally { button.disabled = false; }
});

$('generate').onclick = async () => {
  const voiceId = $('voice-select').value;
  const script = $('script').value.trim();
  const engine = $('engine-select').value;
  if (!voiceId || !script) { message('generate-message', '请先选音色并填写中文文案。', true); return; }
  $('generate').disabled = true;
  message('generate-message', engine === 'omnivoice' ? 'OmniVoice 正在生成。首次或切换回来可能等待约 1～2 分钟，请保持页面打开…' : '千问正在生成，请保持页面打开…');
  const body = new FormData(); body.set('voice_id', voiceId); body.set('text', script); body.set('engine', engine);
  try {
    const result = await request('/api/generate', { method: 'POST', body });
    await loadOutputs();
    message('generate-message', '生成完成，可以试听并下载。');
  } catch (error) { message('generate-message', error.message, true); }
  finally { $('generate').disabled = false; }
};

request('/api/status').then((status) => {
  const engines = status.engines || [];
  for (const option of $('engine-select').options) {
    const item = engines.find((engine) => engine.id === option.value);
    option.disabled = !item?.available;
    if (item && !item.available) option.textContent = `${item.name}（未安装）`;
  }
  const saved = localStorage.getItem('shengke-engine');
  if ([...$('engine-select').options].some((option) => option.value === saved && !option.disabled)) $('engine-select').value = saved;
  $('status').textContent = engines.filter((engine) => engine.available).length === 2 ? '● 双模型已就绪 · 本机运行' : status.model_downloaded ? '● 模型已就绪 · 本机运行' : '○ 模型尚未下载';
}).catch(() => { $('status').textContent = '○ 服务连接异常'; });
$('engine-select').addEventListener('change', () => localStorage.setItem('shengke-engine', $('engine-select').value));
refresh().then(loadOutputs);
