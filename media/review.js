(function () {
  const vscode = acquireVsCodeApi();
  const filesEl = document.getElementById('files');
  const emptyEl = document.getElementById('empty');
  const emptyTitleEl = document.getElementById('empty-title');
  const fileTitleEl = document.getElementById('file-title');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnAcceptFile = document.getElementById('btn-accept-file');
  const btnRejectFile = document.getElementById('btn-reject-file');

  let busy = false;
  let currentKey = undefined;

  function post(type, extra) {
    vscode.postMessage(Object.assign({ type: type }, extra || {}));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusLetter(status) {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'modified') return 'M';
    return '✓';
  }

  function statusText(status) {
    if (status === 'added') return '新增';
    if (status === 'deleted') return '删除';
    if (status === 'modified') return '修改';
    return '无差异';
  }

  btnRefresh.addEventListener('click', function () {
    post('refresh');
  });
  btnAcceptFile.addEventListener('click', function () {
    if (currentKey) {
      post('acceptFile', { key: currentKey });
    }
  });
  btnRejectFile.addEventListener('click', function () {
    if (currentKey) {
      post('rejectFile', { key: currentKey });
    }
  });

  filesEl.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button || busy) {
      return;
    }
    const payload = { key: button.dataset.key };
    if (button.dataset.index !== undefined) {
      payload.hunkIndex = Number(button.dataset.index);
    }
    post(button.dataset.action, payload);
  });

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'state') {
      render(message);
    } else if (message && message.type === 'scrollToHunk') {
      scrollToHunk(message.hunkIndex);
    }
  });

  function scrollToHunk(hunkIndex) {
    if (hunkIndex === undefined || hunkIndex === null) {
      return;
    }
    const bars = filesEl.querySelectorAll('.hunk-bar');
    for (let i = 0; i < bars.length; i++) {
      if (Number(bars[i].dataset.hunkIndex) === hunkIndex) {
        bars[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        bars[i].classList.add('flash');
        setTimeout(function () {
          bars[i].classList.remove('flash');
        }, 1200);
        return;
      }
    }
  }

  function rowHtml(row) {
    if (row.kind === 'hunk') {
      return (
        '<div class="hunk-bar" data-hunk-index="' +
        row.hunkIndex +
        '">' +
        '<span class="hunk-left">' +
        '<span class="hunk-chip">更改 ' +
        (row.hunkIndex + 1) +
        '</span>' +
        '<span class="hunk-range">' +
        escapeHtml(row.label) +
        '</span>' +
        '<span class="counts"><span class="add">+' +
        row.additions +
        '</span><span class="del">−' +
        row.deletions +
        '</span></span>' +
        '</span>' +
        '<span class="hunk-actions">' +
        '<button class="btn accept tiny" data-action="acceptHunk" data-key="' +
        escapeHtml(currentKey) +
        '" data-index="' +
        row.hunkIndex +
        '">接受</button>' +
        '<button class="btn reject tiny" data-action="rejectHunk" data-key="' +
        escapeHtml(currentKey) +
        '" data-index="' +
        row.hunkIndex +
        '">拒绝</button>' +
        '</span></div>'
      );
    }
    const kind = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx';
    const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
    const oldNo = row.kind === 'add' ? '' : row.oldLine;
    const newNo = row.kind === 'del' ? '' : row.newLine;
    return (
      '<div class="line ' +
      kind +
      '">' +
      '<span class="ln">' +
      oldNo +
      '</span>' +
      '<span class="ln">' +
      newNo +
      '</span>' +
      '<span class="sign">' +
      sign +
      '</span>' +
      '<span class="code">' +
      escapeHtml(row.text) +
      '</span>' +
      '</div>'
    );
  }

  function fileHtml(file) {
    let body;
    if (file.isBinary) {
      body = '<div class="note">二进制文件，无法逐行显示。可使用上方的“接受当前文件 / 拒绝当前文件”。</div>';
    } else if (file.tooLarge) {
      body = '<div class="note">文件过大，无法逐行显示。可使用上方的“接受当前文件 / 拒绝当前文件”。</div>';
    } else if (file.rows.length === 0) {
      body = '<div class="note">空文件。</div>';
    } else {
      body = '<div class="lines">' + file.rows.map(rowHtml).join('') + '</div>';
    }

    const note = !file.pending && file.note ? '<div class="note info">' + escapeHtml(file.note) + '</div>' : '';

    return (
      '<div class="file-info">' +
      '<span class="badge ' +
      file.status +
      '" title="' +
      statusText(file.status) +
      '">' +
      statusLetter(file.status) +
      '</span>' +
      '<span class="path" title="' +
      escapeHtml(file.relativePath) +
      '">' +
      escapeHtml(file.relativePath) +
      '</span>' +
      '<span class="counts"><span class="add">+' +
      file.additions +
      '</span><span class="del">−' +
      file.deletions +
      '</span></span>' +
      '<span class="file-actions">' +
      '<button class="btn ghost tiny" data-action="openDiff" data-key="' +
      escapeHtml(file.key) +
      '">打开原生对比</button>' +
      '<button class="btn ghost tiny" data-action="reveal" data-key="' +
      escapeHtml(file.key) +
      '">在资源管理器中显示</button>' +
      '</span>' +
      '</div>' +
      note +
      body
    );
  }

  function render(state) {
    busy = Boolean(state.busy);
    const file = state.file;
    currentKey = file ? file.key : undefined;

    btnRefresh.disabled = busy;
    btnAcceptFile.disabled = busy || !file || !file.pending;
    btnRejectFile.disabled = busy || !file || !file.pending;

    const scrollTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;

    if (!file) {
      fileTitleEl.textContent = '';
      filesEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      emptyTitleEl.textContent =
        state.totalFiles > 0 ? '请在左侧“AI 审查”中选择一个文件。' : '没有待审查的改动。';
    } else {
      emptyEl.classList.add('hidden');
      fileTitleEl.textContent = file.relativePath + '（' + statusText(file.status) + '）';
      filesEl.innerHTML = fileHtml(file);
    }

    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = scrollTop;
    }
  }

  post('ready');
})();
