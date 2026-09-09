(function(){
  "use strict";

  var session = null;
  var state = { workouts: [], logs: {}, todos: [] };
  var leaderboard = null;
  var uiState = { confirmDeleteId: null, historyOpen: {}, renamingId: null, editingToday: null };

  // ---------------- local cache + offline sync queue ----------------
  var CACHE_KEY = "repTrackerCache";
  var cache = loadCache();
  var pendingQueue = cache.queue || [];
  var flushing = false;
  var syncStatus = "unknown";

  function loadCache(){
    try{
      var raw = localStorage.getItem(CACHE_KEY);
      if(!raw) return { user:null, workouts:[], logs:{}, todos:[], leaderboard:null, queue:[] };
      var parsed = JSON.parse(raw);
      if(!Array.isArray(parsed.queue)) parsed.queue = [];
      return parsed;
    }catch(e){ return { user:null, workouts:[], logs:{}, todos:[], leaderboard:null, queue:[] }; }
  }
  function persistCache(){
    cache.user = session;
    cache.workouts = state.workouts;
    cache.logs = state.logs;
    cache.todos = state.todos;
    cache.leaderboard = leaderboard;
    cache.queue = pendingQueue;
    try{ localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }catch(e){}
  }
  function setSyncStatus(status){
    syncStatus = status;
    var wrap = document.getElementById("sync-status");
    var label = document.getElementById("sync-label");
    if(!wrap || !label) return;
    wrap.className = "sync-status " + status;
    if(status === "synced") label.textContent = "Synced";
    else if(status === "pending") label.textContent = pendingQueue.length + " change" + (pendingQueue.length===1?"":"s") + " pending";
    else if(status === "offline") label.textContent = "Offline";
    else label.textContent = "Connecting…";
  }
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function pad(n){ return String(n).padStart(2,"0"); }
  function dateStr(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
  function todayStr(){ return dateStr(new Date()); }
  function isoWeekday(d){ return ((d.getDay()+6)%7)+1; }
  function startOfWeek(d){
    var wd = isoWeekday(d);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (wd-1));
  }
  function fmtDateLabel(dstr){
    var parts = dstr.split("-").map(Number);
    var d = new Date(parts[0], parts[1]-1, parts[2]);
    return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
  }
  function fmtAvg(n){
    if(Number.isInteger(n)) return String(n);
    return n.toFixed(1);
  }
  function el(tag, cls, html){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html !== undefined) e.innerHTML = html;
    return e;
  }
  function textEl(tag, cls, text){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  async function api(method, url, body){
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 8000);
    var opts = { method: method, headers: {}, signal: controller.signal };
    if(body !== undefined){
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res;
    try{
      res = await fetch(url, opts);
    }catch(e){
      clearTimeout(timer);
      var offlineErr = new Error("offline");
      offlineErr.offline = true;
      throw offlineErr;
    }
    clearTimeout(timer);
    var data = null;
    var bodyText = null;
    try{ bodyText = await res.text(); data = JSON.parse(bodyText); }catch(e){}
    if(!res.ok){
      if(data === null){
        // Not a JSON error from our own API — most likely a tunnel/proxy
        // error page (e.g. ngrok's 502 when the local server is down).
        // Treat it as offline so it gets retried instead of dropped.
        var offlineErr2 = new Error("offline");
        offlineErr2.offline = true;
        throw offlineErr2;
      }
      var err = new Error((data && data.error) || ("http_"+res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------------- installability ----------------
  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    deferredInstallPrompt = e;
    var btn = document.getElementById("install-btn");
    if(btn) btn.hidden = false;
  });
  document.getElementById("install-btn").addEventListener("click", function(){
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(function(){
      deferredInstallPrompt = null;
      document.getElementById("install-btn").hidden = true;
    });
  });
  window.addEventListener("appinstalled", function(){
    document.getElementById("install-btn").hidden = true;
  });

  // ---------------- auth ----------------
  async function init(){
    if("serviceWorker" in navigator){
      navigator.serviceWorker.register("/sw.js").catch(function(){});
    }
    try{
      var sess = await api("GET","/api/session");
      await showApp(sess);
    }catch(e){
      if(e.offline && cache.user){
        await showApp(cache.user);
      } else {
        showLogin();
      }
    }
  }
  function showLogin(){
    document.getElementById("login-screen").hidden = false;
    document.getElementById("app-screen").hidden = true;
  }
  async function showApp(sess){
    session = sess;
    document.getElementById("login-screen").hidden = true;
    document.getElementById("app-screen").hidden = false;
    document.getElementById("user-name").textContent = session.username;
    document.getElementById("role-tag").hidden = session.role !== "admin";
    document.getElementById("add-form").hidden = session.role !== "admin";
    await loadAll();
  }

  document.getElementById("login-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var errorBox = document.getElementById("login-error");
    errorBox.hidden = true;
    var username = document.getElementById("login-username").value.trim();
    var password = document.getElementById("login-password").value;
    try{
      var sess = await api("POST","/api/login",{username:username,password:password});
      document.getElementById("login-password").value = "";
      await showApp(sess);
    }catch(err){
      errorBox.textContent = err.offline
        ? "Can't reach the server right now — check your connection and try again."
        : "Wrong username or password.";
      errorBox.hidden = false;
    }
  });
  document.getElementById("signout-btn").addEventListener("click", async function(){
    if(pendingQueue.length){
      await flushQueue();
      if(pendingQueue.length){
        var proceed = confirm(
          "You have " + pendingQueue.length + " change(s) not yet synced to the server. " +
          "If someone else signs in on this device before they sync, those changes could end up under the wrong name. Sign out anyway?"
        );
        if(!proceed) return;
      }
    }
    cache.user = null;
    persistCache();
    try{ await api("POST","/api/logout"); }catch(e){}
    window.location.reload();
  });

  // ---------------- data loading ----------------
  async function loadAll(){
    // hydrate instantly from local cache so the UI works even fully offline
    state.workouts = cache.workouts || [];
    state.logs = cache.logs || {};
    state.todos = cache.todos || [];
    leaderboard = cache.leaderboard || null;
    render();
    await trySync();
  }
  async function pullFresh(){
    var results = await Promise.all([
      api("GET","/api/workouts"),
      api("GET","/api/logs"),
      api("GET","/api/todos"),
      api("GET","/api/leaderboard")
    ]);
    state.workouts = results[0];
    state.logs = results[1];
    state.todos = results[2];
    leaderboard = results[3];
    persistCache();
    render();
  }
  async function trySync(){
    if(!session) return;
    if(pendingQueue.length){
      await flushQueue();
      return;
    }
    try{
      await pullFresh();
      setSyncStatus("synced");
    }catch(e){
      if(e.offline) setSyncStatus("offline");
    }
  }
  async function loadLeaderboard(){
    try{
      leaderboard = await api("GET","/api/leaderboard");
      persistCache();
      renderLeaderboard();
    }catch(e){}
  }
  setInterval(function(){ if(session) trySync(); }, 60000);
  window.addEventListener("online", function(){ if(session) trySync(); });

  // ---------------- offline queue ----------------
  function enqueue(type, payload){
    pendingQueue.push({ id: uid(), type: type, payload: payload, createdAt: Date.now() });
    persistCache();
    setSyncStatus(pendingQueue.length ? "pending" : "synced");
    flushQueue();
  }
  function remapItem(item, idRemap){
    if(item.payload && item.payload.workoutId && idRemap[item.payload.workoutId]){
      item.payload.workoutId = idRemap[item.payload.workoutId];
    }
    if(item.payload && item.payload.id && idRemap[item.payload.id]){
      item.payload.id = idRemap[item.payload.id];
    }
  }
  function sendQueueItem(item){
    switch(item.type){
      case "addEntry": return api("POST","/api/logs/"+item.payload.workoutId+"/entries", { date: item.payload.date, amount: item.payload.amount });
      case "setDay": return api("PUT","/api/logs/"+item.payload.workoutId+"/day", { date: item.payload.date, entries: item.payload.entries });
      case "addTodo": return api("POST","/api/todos", { text: item.payload.text });
      case "toggleTodo": return api("PATCH","/api/todos/"+item.payload.id, { done: item.payload.done });
      case "deleteTodo": return api("DELETE","/api/todos/"+item.payload.id);
      case "moveTodoBottom": return api("POST","/api/todos/"+item.payload.id+"/move-to-bottom");
      case "addWorkout": return api("POST","/api/workouts", { name: item.payload.name, unit: item.payload.unit });
      case "editWorkout": return api("PUT","/api/workouts/"+item.payload.id, { name: item.payload.name, unit: item.payload.unit });
      case "deleteWorkout": return api("DELETE","/api/workouts/"+item.payload.id);
      default: return Promise.resolve(null);
    }
  }
  async function flushQueue(){
    if(flushing) return;
    flushing = true;
    setSyncStatus(pendingQueue.length ? "pending" : "synced");
    var idRemap = {};
    while(pendingQueue.length){
      var item = pendingQueue[0];
      remapItem(item, idRemap);
      try{
        var result = await sendQueueItem(item);
        if((item.type === "addTodo" || item.type === "addWorkout") && result && result.id){
          idRemap[item.payload.clientId] = result.id;
        }
        pendingQueue.shift();
        persistCache();
      }catch(e){
        if(e.offline){
          flushing = false;
          setSyncStatus(pendingQueue.length ? "pending" : "offline");
          return;
        }
        // server rejected this action (validation/permission) — drop it, it can't succeed by retrying
        pendingQueue.shift();
        persistCache();
      }
    }
    flushing = false;
    try{
      await pullFresh();
      setSyncStatus("synced");
    }catch(e){
      if(e.offline) setSyncStatus("offline");
    }
  }

  // ---------------- log helpers (client-side mirror of server logic) ----------------
  function getDayEntries(workoutId, dstr){
    var log = state.logs[workoutId];
    if(!log) return [];
    var v = log[dstr];
    if(v == null) return [];
    if(typeof v === "number") return v > 0 ? [v] : [];
    if(v && Array.isArray(v.entries)) return v.entries.slice();
    return [];
  }
  function getCount(workoutId, dstr){
    return getDayEntries(workoutId, dstr).reduce(function(a,b){ return a+b; }, 0);
  }
  function addToToday(workoutId, amount){
    var t = todayStr();
    var entries = getDayEntries(workoutId, t);
    entries.push(amount);
    if(!state.logs[workoutId]) state.logs[workoutId] = {};
    state.logs[workoutId][t] = { entries: entries };
    persistCache();
    render();
    enqueue("addEntry", { workoutId: workoutId, date: t, amount: amount });
  }
  function setCount(workoutId, dstr, value){
    var v = Math.max(0, Number(value) || 0);
    var entries = v > 0 ? [v] : [];
    if(!state.logs[workoutId]) state.logs[workoutId] = {};
    if(entries.length === 0) delete state.logs[workoutId][dstr];
    else state.logs[workoutId][dstr] = { entries: entries };
    persistCache();
    render();
    enqueue("setDay", { workoutId: workoutId, date: dstr, entries: entries });
  }

  function weekStats(workoutId){
    var now = new Date();
    var monday = startOfWeek(now);
    var elapsed = isoWeekday(now);
    var sum = 0;
    for(var i=0;i<elapsed;i++){
      var d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()+i);
      sum += getCount(workoutId, dateStr(d));
    }
    return { sum: sum, days: elapsed, avg: sum/elapsed };
  }
  function monthStats(workoutId){
    var now = new Date();
    var elapsed = now.getDate();
    var sum = 0;
    for(var i=1;i<=elapsed;i++){
      var d = new Date(now.getFullYear(), now.getMonth(), i);
      sum += getCount(workoutId, dateStr(d));
    }
    return { sum: sum, days: elapsed, avg: sum/elapsed };
  }

  // ---------------- render root ----------------
  function render(){
    var list = document.getElementById("workout-list");
    list.innerHTML = "";
    renderCharts();
    renderTodos();
    renderLeaderboard();

    if(state.workouts.length === 0){
      var empty = el("div","empty-state");
      empty.innerHTML =
        '<div class="glyph">00 workouts logged</div>'+
        '<h2>Nothing tracked yet</h2>'+
        '<p>'+(session.role==="admin" ? "Add your group's first workout above" : "Ask your admin to add a workout")+' &mdash; log a count today, and see weekly and monthly averages build up.</p>';
      list.appendChild(empty);
      return;
    }
    state.workouts.forEach(function(w){ list.appendChild(renderCard(w)); });
  }

  function renderCard(w){
    var card = el("div","card");
    card.dataset.id = w.id;
    var isAdmin = session.role === "admin";

    var head = el("div","card-head");
    var title = el("div","card-title");
    if(isAdmin && uiState.renamingId === w.id){
      var rin = document.createElement("input");
      rin.type="text"; rin.className="rename-input"; rin.value=w.name; rin.maxLength=40;
      title.appendChild(rin);
      setTimeout(function(){ rin.focus(); rin.select(); },0);
      var committed = false;
      function commitRename(){
        if(committed) return; committed = true;
        var v = rin.value.trim();
        uiState.renamingId = null;
        if(v && v !== w.name){
          w.name = v;
          persistCache();
          render();
          enqueue("editWorkout", { id: w.id, name: v, unit: w.unit });
        } else {
          render();
        }
      }
      rin.addEventListener("keydown", function(e){
        if(e.key==="Enter") commitRename();
        if(e.key==="Escape"){ committed=true; uiState.renamingId=null; render(); }
      });
      rin.addEventListener("blur", commitRename);
    } else {
      title.appendChild(document.createTextNode(w.name));
      if(w.unit){ title.appendChild(textEl("span","unit-tag", w.unit)); }
    }
    head.appendChild(title);

    var actions = el("div","card-actions");
    var ts = timerStates[w.id];
    if(ts && (ts.running || ts.ringing)){
      var liveBadge = textEl("span","timer-live"+(ts.ringing?" ringing":""), fmtClock(ts.remainingMs));
      liveBadge.dataset.timerLiveFor = w.id;
      actions.appendChild(liveBadge);
    }
    var timerBtn = iconButton(timerIcon(), "Rest timer for "+w.name, function(){ openTimerPanel(w.id); });
    timerBtn.classList.add("timer-toggle");
    timerBtn.dataset.timerFor = w.id;
    if(ts && ts.running) timerBtn.classList.add("running");
    if(ts && ts.ringing) timerBtn.classList.add("ringing");
    actions.appendChild(timerBtn);
    if(isAdmin){
      var editBtn = iconButton(pencilIcon(), "Rename workout", function(){
        uiState.renamingId = w.id; render();
      });
      var delBtn = iconButton(trashIcon(), "Delete workout", function(){
        uiState.confirmDeleteId = w.id; render();
      }, "danger");
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
    }
    head.appendChild(actions);
    card.appendChild(head);

    if(isAdmin && uiState.confirmDeleteId === w.id){
      var confirmRow = el("div","confirm-row");
      confirmRow.appendChild(document.createTextNode("Delete \""+w.name+"\" and everyone's history for it?"));
      var spacer = el("span","spacer"); confirmRow.appendChild(spacer);
      var yes = el("button","link-btn","Delete");
      yes.addEventListener("click", function(){
        state.workouts = state.workouts.filter(function(x){return x.id!==w.id;});
        delete state.logs[w.id];
        var wts = timerStates[w.id];
        if(wts){ if(wts.intervalId) clearInterval(wts.intervalId); delete timerStates[w.id]; if(activeTimerWorkoutId===w.id) closeTimerPanel(); }
        uiState.confirmDeleteId = null;
        persistCache();
        render();
        enqueue("deleteWorkout", { id: w.id });
      });
      var no = el("button","link-btn","Cancel");
      no.style.marginLeft="12px";
      no.addEventListener("click", function(){ uiState.confirmDeleteId=null; render(); });
      confirmRow.appendChild(yes); confirmRow.appendChild(no);
      card.appendChild(confirmRow);
    }

    var todayRow = el("div","today-row");
    var figure = el("div","today-figure");
    figure.appendChild(el("div","today-label","Today"));
    var valueWrap = el("div","today-value");
    var t = todayStr();
    var count = getCount(w.id, t);
    if(uiState.editingToday === w.id){
      var tin = document.createElement("input");
      tin.type="number"; tin.min="0"; tin.step="any"; tin.value=count;
      valueWrap.appendChild(tin);
      setTimeout(function(){ tin.focus(); tin.select(); },0);
      var doneEdit = false;
      function commitToday(){
        if(doneEdit) return; doneEdit = true;
        var v = tin.value;
        uiState.editingToday = null;
        setCount(w.id, t, v);
      }
      tin.addEventListener("keydown", function(e){ if(e.key==="Enter") commitToday(); if(e.key==="Escape"){ doneEdit=true; uiState.editingToday=null; render(); } });
      tin.addEventListener("blur", commitToday);
    } else {
      valueWrap.textContent = fmtAvg(count);
      valueWrap.title = "Click to edit today's count";
      valueWrap.addEventListener("click", function(){ uiState.editingToday = w.id; render(); });
    }
    figure.appendChild(valueWrap);
    var todayEntries = getDayEntries(w.id, t);
    if(todayEntries.length > 0){
      figure.appendChild(textEl("div","today-breakdown", todayEntries.map(fmtAvg).join(", ")));
    }
    todayRow.appendChild(figure);

    var quickAdd = el("div","quick-add");
    var qty = document.createElement("input");
    qty.type="number"; qty.min="0"; qty.step="any"; qty.className="qty-input"; qty.placeholder="amt";
    var addBtn = el("button","btn btn-ghost","Add");
    addBtn.addEventListener("click", function(){
      var raw = qty.value.trim();
      var v = raw === "" ? 1 : Number(raw);
      if(v>0){ qty.value=""; addToToday(w.id, v); }
    });
    qty.addEventListener("keydown", function(e){ if(e.key==="Enter") addBtn.click(); });
    var chip1 = el("button","chip","+1");
    chip1.addEventListener("click", function(){ addToToday(w.id,1); });
    var chip5 = el("button","chip","+5");
    chip5.addEventListener("click", function(){ addToToday(w.id,5); });
    var chip10 = el("button","chip","+10");
    chip10.addEventListener("click", function(){ addToToday(w.id,10); });
    quickAdd.appendChild(chip1); quickAdd.appendChild(chip5); quickAdd.appendChild(chip10);
    quickAdd.appendChild(qty); quickAdd.appendChild(addBtn);
    todayRow.appendChild(quickAdd);
    card.appendChild(todayRow);

    var ws = weekStats(w.id), ms = monthStats(w.id);
    var strip = el("div","stat-strip");
    strip.appendChild(statBlock("Today", fmtAvg(count), null));
    strip.appendChild(statBlock("This week", fmtAvg(ws.avg)+"/day", "sum "+fmtAvg(ws.sum)+" ÷ "+ws.days+" days"));
    strip.appendChild(statBlock("This month", fmtAvg(ms.avg)+"/day", "sum "+fmtAvg(ms.sum)+" ÷ "+ms.days+" days"));
    card.appendChild(strip);

    var isOpen = !!uiState.historyOpen[w.id];
    var toggle = el("button","history-toggle"+(isOpen?" open":""));
    toggle.innerHTML = chevronIcon()+"<span>"+(isOpen?"Hide":"Show")+" history</span>";
    toggle.addEventListener("click", function(){ uiState.historyOpen[w.id] = !isOpen; render(); });
    card.appendChild(toggle);

    if(isOpen){
      var panel = el("div","history-panel");
      var days = 14;
      for(var i=0;i<days;i++){
        var d = new Date(); d.setDate(d.getDate()-i);
        var dstr = dateStr(d);
        var row = el("div","history-row");
        var label = textEl("span","history-date"+(i===0?" is-today":""), i===0 ? "Today" : fmtDateLabel(dstr));
        row.appendChild(label);
        var right = el("span","history-right");
        var valSpan = textEl("span","history-value", fmtAvg(getCount(w.id,dstr)));
        (function(dstr, valSpan, w){
          valSpan.addEventListener("click", function(){
            var input = document.createElement("input");
            input.type="number"; input.min="0"; input.step="any";
            input.value = getCount(w.id,dstr);
            valSpan.replaceWith(input);
            input.focus(); input.select();
            var done = false;
            function commit(){
              if(done) return; done = true;
              setCount(w.id, dstr, input.value);
            }
            input.addEventListener("keydown", function(e){ if(e.key==="Enter") commit(); if(e.key==="Escape"){ done=true; render(); } });
            input.addEventListener("blur", commit);
          });
        })(dstr, valSpan, w);
        right.appendChild(valSpan);
        var dayEntries = getDayEntries(w.id, dstr);
        if(dayEntries.length > 1){
          right.appendChild(textEl("span","history-breakdown", "("+dayEntries.map(fmtAvg).join(", ")+")"));
        }
        row.appendChild(right);
        panel.appendChild(row);
      }
      card.appendChild(panel);
    }

    return card;
  }

  function statBlock(label, value, sub){
    var s = el("div","stat");
    s.appendChild(el("div","stat-label",label));
    s.appendChild(el("div","stat-value",value));
    if(sub) s.appendChild(el("div","stat-sub",sub));
    return s;
  }
  function iconButton(svg, label, onClick, extraClass){
    var b = el("button","icon-btn"+(extraClass?" "+extraClass:""));
    b.innerHTML = svg;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", onClick);
    return b;
  }
  function pencilIcon(){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'; }
  function trashIcon(){ return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'; }
  function chevronIcon(){ return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'; }
  function timerIcon(){ return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 3h6"/><path d="M19 5l-1.5-1.5"/></svg>'; }

  document.getElementById("add-form").addEventListener("submit", function(e){
    e.preventDefault();
    var nameInput = document.getElementById("new-name");
    var unitInput = document.getElementById("new-unit");
    var name = nameInput.value.trim();
    if(!name) return;
    var unit = unitInput.value.trim() || "reps";
    var clientId = "local-" + uid();
    state.workouts.push({ id: clientId, name: name, unit: unit, createdAt: new Date().toISOString() });
    persistCache();
    nameInput.value=""; unitInput.value="";
    render();
    nameInput.focus();
    enqueue("addWorkout", { clientId: clientId, name: name, unit: unit });
  });

  function tickClock(){}
  setInterval(function(){
    var prevToday = window.__rt_today || todayStr();
    var nowToday = todayStr();
    if(nowToday !== prevToday){ render(); }
    window.__rt_today = nowToday;
  }, 30000);

  // ---------------- donut charts (today / this week / this month) ----------------
  var CHART_COLORS = ["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"];
  var CHART_OTHER_COLOR = "#5b606b";

  function polarToXY(cx, cy, r, angleDeg){
    var rad = (angleDeg-90) * Math.PI/180;
    return { x: cx + r*Math.cos(rad), y: cy + r*Math.sin(rad) };
  }
  function donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle){
    var largeArc = (endAngle-startAngle) > 180 ? 1 : 0;
    var p1 = polarToXY(cx,cy,rOuter,startAngle);
    var p2 = polarToXY(cx,cy,rOuter,endAngle);
    var p3 = polarToXY(cx,cy,rInner,endAngle);
    var p4 = polarToXY(cx,cy,rInner,startAngle);
    return ["M",p1.x,p1.y,"A",rOuter,rOuter,0,largeArc,1,p2.x,p2.y,"L",p3.x,p3.y,"A",rInner,rInner,0,largeArc,0,p4.x,p4.y,"Z"].join(" ");
  }
  function renderDonut(containerId, title, totalFn, emptyMsg){
    var wrap = document.getElementById(containerId);
    if(!wrap) return;
    wrap.innerHTML = "";
    var totals = state.workouts.map(function(w, idx){
      return { id:w.id, name:w.name, total: totalFn(w.id), color: idx < CHART_COLORS.length ? CHART_COLORS[idx] : CHART_OTHER_COLOR };
    });
    var grandTotal = totals.reduce(function(a,b){ return a+b.total; }, 0);
    if(state.workouts.length === 0 || grandTotal === 0){
      wrap.className = "chart-card empty";
      wrap.textContent = emptyMsg;
      return;
    }
    wrap.className = "chart-card";
    wrap.appendChild(el("div","chart-title",title));
    var body = el("div","chart-body");
    var donutWrap = el("div","chart-donut-wrap");
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("viewBox","0 0 200 200");
    var cx=100, cy=100, rOuter=88, rInner=56;
    var gapDeg = 1.4;
    var sorted = totals.filter(function(t){return t.total>0;}).sort(function(a,b){return b.total-a.total;});
    var angle = 0;
    sorted.forEach(function(t){
      var frac = t.total/grandTotal;
      var sweep = frac*360;
      var start = angle + gapDeg/2;
      var end = angle + sweep - gapDeg/2;
      if(end > start){
        var path = document.createElementNS(svgNS,"path");
        path.setAttribute("d", donutSlicePath(cx,cy,rOuter,rInner,start,end));
        path.setAttribute("fill", t.color);
        var titleEl = document.createElementNS(svgNS,"title");
        titleEl.textContent = t.name + ": " + fmtAvg(t.total) + " (" + Math.round(frac*100) + "%)";
        path.appendChild(titleEl);
        svg.appendChild(path);
      }
      angle += sweep;
    });
    donutWrap.appendChild(svg);
    var center = el("div","chart-center");
    center.appendChild(el("div","total", fmtAvg(grandTotal)));
    center.appendChild(el("div","clabel","reps"));
    donutWrap.appendChild(center);
    body.appendChild(donutWrap);
    var legend = el("div","chart-legend");
    sorted.forEach(function(t){
      var row = el("div","chart-legend-row");
      var dot = el("span","chart-legend-dot");
      dot.style.background = t.color;
      row.appendChild(dot);
      row.appendChild(textEl("span","chart-legend-name", t.name));
      row.appendChild(el("span","chart-legend-pct", fmtAvg(t.total)+" · "+Math.round((t.total/grandTotal)*100)+"%"));
      legend.appendChild(row);
    });
    body.appendChild(legend);
    wrap.appendChild(body);
  }
  function renderCharts(){
    renderDonut("chart-card-today", "Today", function(id){ return getCount(id, todayStr()); }, "Log some reps today to see today's split.");
    renderDonut("chart-card-week", "This week", function(id){ return weekStats(id).sum; }, "No reps logged yet this week.");
    renderDonut("chart-card-month", "This month", function(id){ return monthStats(id).sum; }, "No reps logged yet this month.");
  }

  // ---------------- leaderboard ----------------
  function renderLeaderboard(){
    renderLbList("lb-yesterday","Yesterday", leaderboard ? leaderboard.yesterday : []);
    renderLbList("lb-week","This week", leaderboard ? leaderboard.week : []);
    renderLbList("lb-month","This month", leaderboard ? leaderboard.month : []);
    renderLbUsers();
  }
  function colorForWorkout(workoutId){
    var idx = state.workouts.findIndex(function(w){ return w.id === workoutId; });
    return idx >= 0 && idx < CHART_COLORS.length ? CHART_COLORS[idx] : CHART_OTHER_COLOR;
  }
  function miniDonutSVG(breakdown){
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("viewBox","0 0 100 100");
    var total = breakdown.reduce(function(a,b){ return a+b.total; }, 0);
    if(total <= 0) return svg;
    var cx=50, cy=50, rOuter=44, rInner=22;
    var gapDeg = breakdown.length > 1 ? 2 : 0;
    var angle = 0;
    breakdown.forEach(function(b){
      var frac = b.total/total;
      var sweep = frac*360;
      var start = angle + gapDeg/2;
      var end = angle + sweep - gapDeg/2;
      if(end > start){
        var path = document.createElementNS(svgNS,"path");
        path.setAttribute("d", donutSlicePath(cx,cy,rOuter,rInner,start,end));
        path.setAttribute("fill", colorForWorkout(b.id));
        svg.appendChild(path);
      }
      angle += sweep;
    });
    return svg;
  }
  function renderLbList(containerId, title, rows){
    var wrap = document.getElementById(containerId);
    if(!wrap) return;
    wrap.innerHTML = "";
    wrap.appendChild(el("div","lb-title", title));
    if(!rows || rows.length === 0){
      wrap.appendChild(el("div","lb-empty","No reps logged yet."));
      return;
    }
    rows.forEach(function(r, i){
      var row = el("div","lb-person-row");
      var donutWrap = el("div","lb-donut");
      if(r.breakdown && r.breakdown.length){
        donutWrap.appendChild(miniDonutSVG(r.breakdown));
      }
      row.appendChild(donutWrap);
      var info = el("div","lb-info");
      var nameLine = el("div","lb-name-line");
      nameLine.appendChild(textEl("span","lb-rank r"+(i+1), String(i+1)));
      nameLine.appendChild(textEl("span","lb-name", r.username));
      nameLine.appendChild(textEl("span","lb-total", fmtAvg(r.total)));
      info.appendChild(nameLine);
      if(r.breakdown && r.breakdown.length){
        var breakdownText = r.breakdown.map(function(b){ return fmtAvg(b.total)+" "+b.name; }).join(", ");
        info.appendChild(textEl("div","lb-breakdown", breakdownText));
      }
      row.appendChild(info);
      wrap.appendChild(row);
    });
  }
  function renderLbUsers(){
    var wrap = document.getElementById("lb-users");
    if(!wrap) return;
    wrap.innerHTML = "";
    wrap.appendChild(el("div","lb-title","Group"));
    var users = (leaderboard && leaderboard.users) || [];
    if(users.length === 0){
      wrap.appendChild(el("div","lb-empty","No users yet."));
      return;
    }
    var list = el("div","lb-userlist");
    users.forEach(function(u){ list.appendChild(textEl("span","lb-user-chip", u)); });
    wrap.appendChild(list);
  }

  // ---------------- to-do list ----------------
  var pendingTodoTimers = {};
  function renderTodos(){
    var list = document.getElementById("todo-list");
    if(!list) return;
    list.innerHTML = "";
    if(!state.todos || state.todos.length === 0){
      list.appendChild(el("div","todo-empty","Nothing on your list."));
      return;
    }
    state.todos.forEach(function(t){
      var row = el("div","todo-item"+(t.done?" done":""));
      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "todo-check";
      check.checked = !!t.done;
      check.setAttribute("aria-label", "Mark \""+t.text+"\" "+(t.done?"not done":"done"));
      check.addEventListener("change", function(){ toggleTodo(t.id); });
      row.appendChild(check);
      row.appendChild(textEl("span","todo-text", t.text));
      var del = iconButton(trashIcon(), "Delete task", function(){
        state.todos = state.todos.filter(function(x){ return x.id !== t.id; });
        if(pendingTodoTimers[t.id]){ clearTimeout(pendingTodoTimers[t.id]); delete pendingTodoTimers[t.id]; }
        persistCache();
        render();
        enqueue("deleteTodo", { id: t.id });
      }, "danger");
      row.appendChild(del);
      list.appendChild(row);
    });
  }
  function toggleTodo(id){
    var t = state.todos.find(function(x){ return x.id === id; });
    if(!t) return;
    t.done = !t.done;
    persistCache();
    render();
    enqueue("toggleTodo", { id: id, done: t.done });
    if(pendingTodoTimers[id]){ clearTimeout(pendingTodoTimers[id]); delete pendingTodoTimers[id]; }
    if(t.done){
      pendingTodoTimers[id] = setTimeout(function(){
        delete pendingTodoTimers[id];
        var idx = state.todos.findIndex(function(x){ return x.id === id; });
        if(idx === -1) return;
        var cur = state.todos[idx];
        if(!cur.done) return;
        state.todos.splice(idx,1);
        state.todos.push(cur);
        persistCache();
        render();
        enqueue("moveTodoBottom", { id: id });
      }, 5000);
    }
  }
  document.getElementById("todo-add-form").addEventListener("submit", function(e){
    e.preventDefault();
    var input = document.getElementById("todo-input");
    var text = input.value.trim();
    if(!text) return;
    input.value = "";
    var clientId = "local-" + uid();
    state.todos.unshift({ id: clientId, text: text, done: false });
    persistCache();
    render();
    input.focus();
    enqueue("addTodo", { clientId: clientId, text: text });
  });

  // ---------------- rest timers (per workout, client-only) ----------------
  var timerStates = {};
  var activeTimerWorkoutId = null;
  var alarmIntervalId = null;
  var sharedAudioCtx = null;

  function getTimerState(workoutId){
    if(!timerStates[workoutId]){
      timerStates[workoutId] = { totalMs:60000, remainingMs:60000, running:false, endTime:null, intervalId:null, ringing:false };
    }
    return timerStates[workoutId];
  }
  function fmtClock(ms){
    var totalSec = Math.max(0, Math.round(ms/1000));
    var m = Math.floor(totalSec/60);
    var s = totalSec%60;
    return m + ":" + pad(s);
  }
  function updateCardTimerUI(workoutId){
    var ts = timerStates[workoutId];
    if(!ts) return;
    var badge = document.querySelector('[data-timer-live-for="'+workoutId+'"]');
    if(badge){ badge.textContent = fmtClock(ts.remainingMs); badge.classList.toggle("ringing", ts.ringing); }
    var btn = document.querySelector('.timer-toggle[data-timer-for="'+workoutId+'"]');
    if(btn){ btn.classList.toggle("running", ts.running); btn.classList.toggle("ringing", ts.ringing); }
  }
  function renderTimerModal(){
    if(!activeTimerWorkoutId) return;
    var ts = getTimerState(activeTimerWorkoutId);
    var w = state.workouts.find(function(x){ return x.id === activeTimerWorkoutId; });
    var titleEl2 = document.getElementById("timer-modal-title");
    if(titleEl2) titleEl2.textContent = (w ? w.name : "Workout") + " Timer";
    document.getElementById("timer-display").textContent = fmtClock(ts.remainingMs);
    document.getElementById("timer-display").classList.toggle("ringing", ts.ringing);
    document.getElementById("timer-start").textContent = ts.running ? "Pause" : "Start";
    document.querySelectorAll("#timer-presets .chip").forEach(function(btn){
      btn.classList.toggle("active", Number(btn.dataset.secs)*1000 === ts.totalMs);
    });
  }
  function setTimerDuration(workoutId, seconds){
    var ts = getTimerState(workoutId);
    if(ts.intervalId){ clearInterval(ts.intervalId); ts.intervalId=null; }
    ts.running = false; ts.ringing = false;
    ts.totalMs = seconds*1000; ts.remainingMs = seconds*1000;
    stopAlarm(); render(); renderTimerModal();
  }
  function tickTimer(workoutId){
    var ts = timerStates[workoutId];
    if(!ts) return;
    var remaining = ts.endTime - Date.now();
    if(remaining <= 0){
      ts.remainingMs = 0;
      clearInterval(ts.intervalId); ts.intervalId = null;
      ts.running = false; ts.ringing = true;
      render(); renderTimerModal(); playAlarm();
      return;
    }
    ts.remainingMs = remaining;
    updateCardTimerUI(workoutId);
    if(activeTimerWorkoutId === workoutId) renderTimerModal();
  }
  function startPauseTimer(workoutId){
    var ts = getTimerState(workoutId);
    if(ts.ringing){ stopAlarm(); ts.ringing = false; }
    if(ts.running){
      ts.remainingMs = Math.max(0, ts.endTime - Date.now());
      clearInterval(ts.intervalId); ts.intervalId = null; ts.running = false;
    } else {
      if(ts.remainingMs <= 0){ ts.remainingMs = ts.totalMs; }
      ts.endTime = Date.now() + ts.remainingMs;
      ts.running = true;
      ts.intervalId = setInterval(function(){ tickTimer(workoutId); }, 250);
    }
    render(); renderTimerModal();
  }
  function resetTimer(workoutId){
    var ts = getTimerState(workoutId);
    if(ts.intervalId){ clearInterval(ts.intervalId); ts.intervalId=null; }
    ts.running = false; ts.ringing = false; ts.remainingMs = ts.totalMs;
    stopAlarm(); render(); renderTimerModal();
  }
  function beep(freq, duration, delay){
    setTimeout(function(){
      try{
        if(!sharedAudioCtx){ sharedAudioCtx = new (window.AudioContext||window.webkitAudioContext)(); }
        var ctx = sharedAudioCtx;
        if(ctx.state === "suspended"){ ctx.resume(); }
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime+0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+duration);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime+duration+0.02);
      }catch(e){}
    }, delay);
  }
  function flashScreen(){
    var fl = document.getElementById("flash-overlay");
    if(!fl) return;
    fl.classList.remove("flashing");
    void fl.offsetWidth;
    fl.classList.add("flashing");
  }
  function playAlarm(){
    stopAlarm();
    var pattern = function(){
      beep(988,0.22,0); beep(740,0.22,240); beep(988,0.22,480); beep(740,0.22,720);
      flashScreen();
    };
    pattern();
    alarmIntervalId = setInterval(pattern, 1300);
    setTimeout(function(){ stopAlarm(); }, 20000);
  }
  function stopAlarm(){
    if(alarmIntervalId){ clearInterval(alarmIntervalId); alarmIntervalId=null; }
  }
  function openTimerPanel(workoutId){
    activeTimerWorkoutId = workoutId;
    var ts = getTimerState(workoutId);
    if(ts.ringing){ stopAlarm(); }
    document.getElementById("timer-overlay").hidden = false;
    renderTimerModal();
  }
  function closeTimerPanel(){
    document.getElementById("timer-overlay").hidden = true;
    stopAlarm();
    activeTimerWorkoutId = null;
  }
  document.getElementById("timer-close").addEventListener("click", closeTimerPanel);
  document.getElementById("timer-overlay").addEventListener("click", function(e){
    if(e.target.id === "timer-overlay") closeTimerPanel();
  });
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && !document.getElementById("timer-overlay").hidden) closeTimerPanel();
  });
  document.addEventListener("click", function(){
    if(alarmIntervalId){ stopAlarm(); }
  });
  document.querySelectorAll("#timer-presets .chip").forEach(function(btn){
    btn.addEventListener("click", function(){
      if(activeTimerWorkoutId) setTimerDuration(activeTimerWorkoutId, Number(btn.dataset.secs));
    });
  });
  document.getElementById("timer-custom-set").addEventListener("click", function(){
    var input = document.getElementById("timer-custom-input");
    var mins = Number(input.value);
    if(mins > 0 && activeTimerWorkoutId){ setTimerDuration(activeTimerWorkoutId, Math.round(mins*60)); input.value=""; }
  });
  document.getElementById("timer-custom-input").addEventListener("keydown", function(e){
    if(e.key === "Enter") document.getElementById("timer-custom-set").click();
  });
  document.getElementById("timer-start").addEventListener("click", function(){
    if(activeTimerWorkoutId) startPauseTimer(activeTimerWorkoutId);
  });
  document.getElementById("timer-reset").addEventListener("click", function(){
    if(activeTimerWorkoutId) resetTimer(activeTimerWorkoutId);
  });

  init();
})();
