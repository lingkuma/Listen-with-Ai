const page = document.querySelector('.page');
if (page) {
  const platform = page.dataset.platform;
  const summary = document.getElementById('summary');
  const logBox = document.getElementById('log');
  const preview = document.getElementById('preview');
  const downloadLink = document.getElementById('downloadLink');
  const stopBtn = document.getElementById('stopBtn');
  let micStream;
  let displayStream;
  let recorder;
  let chunks = [];

  const notes = {
    windows: 'Windows 上请优先使用 Chrome / Edge，并在共享弹窗里勾选系统音频或标签页音频。',
    android: 'Android 上即使请求 audio:true，也经常拿不到 display audio track，这正是测试重点。',
    safari: 'Safari / iOS 上的重点不是“能不能请求”，而是验证最终是否真的得到可用音频轨。'
  };

  const log = (text) => {
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `[${time}] ${text}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };

  const setSummary = (items) => {
    summary.innerHTML = items.map((item) => `<div>${item}</div>`).join('');
  };

  const describeStream = (name, stream) => {
    if (!stream) return `${name}: 未获取`;
    const audio = stream.getAudioTracks();
    const video = stream.getVideoTracks();
    return `${name}: audio=${audio.length}, video=${video.length}, active=${stream.active}`;
  };

  const detect = () => {
    const info = [
      `userAgent: ${navigator.userAgent}`,
      `getUserMedia: ${!!navigator.mediaDevices?.getUserMedia}`,
      `getDisplayMedia: ${!!navigator.mediaDevices?.getDisplayMedia}`,
      `MediaRecorder: ${typeof MediaRecorder !== 'undefined'}`,
      `isSecureContext: ${window.isSecureContext}`,
      notes[platform]
    ];
    setSummary(info);
    info.forEach(log);
  };

  const requestMic = async () => {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = micStream.getAudioTracks()[0];
      log(`麦克风成功: ${track?.label || '未命名音频输入'}`);
      setSummary([describeStream('麦克风流', micStream), describeStream('录屏流', displayStream), notes[platform]]);
    } catch (error) {
      log(`麦克风失败: ${error.name} / ${error.message}`);
      setSummary([`麦克风失败: ${error.name}`, notes[platform]]);
    }
  };

  const requestDisplay = async () => {
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      log(describeStream('录屏流', displayStream));
      displayStream.getTracks().forEach((track) => {
        track.onended = () => log(`轨道结束: ${track.kind} / ${track.label || '未命名轨道'}`);
      });
      const audioTracks = displayStream.getAudioTracks().length;
      const hint = audioTracks > 0 ? '检测到录屏音频轨，可能捕获到标签页或系统音频。' : '未检测到录屏音频轨，通常表示拿不到其他 App / 系统声音。';
      setSummary([describeStream('麦克风流', micStream), describeStream('录屏流', displayStream), hint, notes[platform]]);
      log(hint);
    } catch (error) {
      log(`录屏失败: ${error.name} / ${error.message}`);
      setSummary([`录屏失败: ${error.name}`, notes[platform]]);
    }
  };

  const buildRecordStream = () => {
    const tracks = [];
    if (displayStream) tracks.push(...displayStream.getVideoTracks(), ...displayStream.getAudioTracks());
    if (micStream) tracks.push(...micStream.getAudioTracks());
    return tracks.length ? new MediaStream(tracks) : null;
  };

  const startRecord = () => {
    const stream = buildRecordStream();
    if (!stream) {
      log('没有可录制的流，请先申请麦克风或录屏权限。');
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
      const url = URL.createObjectURL(blob);
      preview.src = url;
      downloadLink.href = url;
      log(`录制完成: ${Math.round(blob.size / 1024)} KB`);
    };
    recorder.start();
    stopBtn.disabled = false;
    log('开始录制当前已授权流。');
  };

  const stopRecord = () => {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      stopBtn.disabled = true;
    }
  };

  document.getElementById('detectBtn').onclick = detect;
  document.getElementById('micBtn').onclick = requestMic;
  document.getElementById('displayBtn').onclick = requestDisplay;
  document.getElementById('recordBtn').onclick = startRecord;
  stopBtn.onclick = stopRecord;
  document.getElementById('clearBtn').onclick = () => {
    logBox.textContent = '';
    setSummary(['日志已清空。', notes[platform]]);
  };

  detect();
}
