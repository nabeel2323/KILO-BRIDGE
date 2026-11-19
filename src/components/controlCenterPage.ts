export const CONTROL_CENTER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Kilo Bridge Control Center</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2d;--panel2:#172239;--line:#26344d;--text:#e8eef9;--muted:#96a6c0;--accent:#7c9cff;--good:#48c78e;--warn:#f1bd5b;--bad:#ef727c}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top left,#172443 0%,var(--bg) 45%);color:var(--text);font:14px/1.5 Inter,Segoe UI,Arial,sans-serif;min-height:100vh}
button,input{font:inherit}button{cursor:pointer;border:1px solid var(--line);background:#20304c;color:var(--text);padding:9px 13px;border-radius:9px}button:hover{border-color:var(--accent);background:#293d60}
#app{min-height:100vh}.hidden{display:none!important}.shell{display:grid;grid-template-columns:238px minmax(0,1fr);min-height:100vh}.side{border-right:1px solid var(--line);background:#0d1526;padding:22px 16px;display:flex;flex-direction:column;gap:24px}.brand{display:flex;gap:12px;align-items:center}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#6e8cff,#8b6bdb);display:grid;place-items:center;font-weight:800;color:white}.brand strong{display:block;font-size:15px}.brand small{color:var(--muted)}.nav{display:grid;gap:6px}.nav button{text-align:left;background:transparent;border-color:transparent;color:#afbdd2}.nav button.active{background:#1b2a46;border-color:#304566;color:white}.side-note{margin-top:auto;border:1px solid var(--line);padding:12px;border-radius:12px;color:var(--muted);font-size:12px}.main{min-width:0}.top{display:flex;align-items:center;justify-content:space-between;padding:20px 28px;border-bottom:1px solid var(--line);background:#0d1526cc;position:sticky;top:0;z-index:2;backdrop-filter:blur(12px)}.top h1{margin:0;font-size:18px}.top-actions{display:flex;gap:8px;align-items:center}.content{padding:28px;max-width:1450px;margin:auto}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{border:1px solid var(--line);background:linear-gradient(180deg,#15213a,#111a2d);border-radius:14px;padding:17px;min-width:0}.metric{font-size:28px;font-weight:700;margin-top:6px}.metric-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.section{margin-top:20px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.section-head h2{font-size:15px;margin:0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#111a2d}table{border-collapse:collapse;width:100%;min-width:650px}th,td{text-align:left;padding:11px 13px;border-bottom:1px solid #24324a}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:#15213a}tr:last-child td{border-bottom:0}tbody tr:hover{background:#192844}.status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 8px;font-size:11px;background:#25334c;color:#d8e4f6}.status.good{color:#8be0b4;background:#163c34}.status.warn{color:#f3ce83;background:#44371f}.status.bad{color:#ff9aa3;background:#46252e}.row-title{font-weight:600}.link{color:#9bb4ff;text-decoration:none}.link:hover{text-decoration:underline}.empty{padding:28px;text-align:center;color:var(--muted)}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.kv{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid #24324a}.kv:last-child{border-bottom:0}.kv span:first-child{color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1323;border:1px solid var(--line);padding:14px;border-radius:10px;color:#dbe6f8;max-height:420px;overflow:auto}.notice{border:1px solid #66502b;background:#30271b;color:#f2d49a;border-radius:12px;padding:13px 15px;margin-bottom:16px}.success{border-color:#275b49;background:#142d29;color:#a1e3c3}.auth{min-height:100vh;display:grid;place-items:center;padding:20px}.auth-card{width:min(460px,100%);border:1px solid var(--line);background:#121c30;border-radius:18px;padding:28px;box-shadow:0 28px 80px #0008}.auth-card h1{margin:0 0 8px;font-size:23px}.field{display:grid;gap:6px;margin:14px 0}.field label{font-size:12px;color:var(--muted)}input{width:100%;border:1px solid var(--line);background:#0a1324;color:var(--text);border-radius:9px;padding:11px 12px}input:focus{outline:2px solid #5d7fe0;border-color:transparent}.primary{background:#536fce;border-color:#718be6}.error{color:#ff9ca5;min-height:22px;margin-top:8px}.footer{color:#8091ad;font-size:12px;margin-top:16px}.pill{border:1px solid var(--line);border-radius:999px;padding:5px 9px;color:var(--muted);font-size:11px}
@media(max-width:900px){.shell{grid-template-columns:1fr}.side{position:relative;padding:12px 16px;border-right:0;border-bottom:1px solid var(--line)}.nav{grid-template-columns:repeat(3,minmax(0,1fr))}.nav button{font-size:12px;text-align:center}.side-note{display:none}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.top{padding:14px 18px}.content{padding:18px}}
@media(max-width:560px){.grid{grid-template-columns:1fr 1fr;gap:8px}.card{padding:12px}.metric{font-size:23px}.detail-grid{grid-template-columns:1fr}.kv{grid-template-columns:115px 1fr}.content{padding:12px}.nav{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
</head>
<body>
<div id="app">
  <div id="auth-view" class="auth hidden">
    <div class="auth-card">
      <div class="brand"><div class="logo">KB</div><div><strong>Kilo Bridge</strong><small>Local Control Center</small></div></div>
      <h1 id="auth-title" style="margin-top:24px">Local operator access</h1>
      <p id="auth-subtitle" class="muted">Sign in to inspect Bridge operations.</p>
      <form id="auth-form">
        <div id="bootstrap-field" class="field hidden"><label for="bootstrap-token">One-time setup token</label><input id="bootstrap-token" autocomplete="off"></div>
        <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="14" required></div>
        <div id="confirm-field" class="field hidden"><label for="confirm-password">Confirm password</label><input id="confirm-password" type="password" autocomplete="new-password" minlength="14"></div>
        <button id="auth-submit" class="primary" type="submit" style="width:100%">Sign in</button>
        <div id="auth-error" class="error"></div>
      </form>
      <div class="footer">Loopback-only access · No cloud connection · Session expires automatically</div>
    </div>
  </div>
  <div id="shell" class="shell hidden">
    <aside class="side">
      <div class="brand"><div class="logo">KB</div><div><strong>Kilo Bridge</strong><small>Control Center · V1.0</small></div></div>
      <nav class="nav">
        <button class="active" data-page="dashboard">Overview</button>
        <button data-page="projects">Projects</button>
        <button data-page="github">GitHub intake</button>
        <button data-page="tasks">Tasks & executions</button>
        <button data-page="review">Review center</button>
        <button data-page="activity">Activity & audit</button>
        <button data-page="settings">Settings</button>
      </nav>
      <div class="side-note">GitHub remains the task source of truth. This interface shows persisted Bridge state and does not start task execution.</div>
    </aside>
    <main class="main">
      <header class="top"><h1 id="page-title">Overview</h1><div class="top-actions"><span class="pill">LOCAL · 127.0.0.1</span><button id="refresh">Refresh</button><button id="logout">Sign out</button></div></header>
      <div id="content" class="content"><div class="empty">Loading Bridge state…</div></div>
    </main>
  </div>
</div>
<script nonce="__CSP_NONCE__">
(function(){
  "use strict";
  var csrfToken = "";
  var currentPage = "dashboard";
  var cachedTasks = [];
  var eventSource = null;
  var eventSourceHasOpened = false;
  var lastStreamRefreshAt = 0;
  var titles = {dashboard:"Overview",projects:"Projects",github:"GitHub intake",tasks:"Tasks & executions",review:"Review center",activity:"Activity & audit",settings:"Settings"};
  function byId(id){return document.getElementById(id);}
  function esc(value){return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];});}
  function badge(value){
    var v=String(value||"UNKNOWN").toUpperCase();
    var cls=(["COMPLETED","DONE","REPORT_READY","PASS","ACTIVE"].indexOf(v)>=0)?"good":(["FAILED","TIMEOUT","BLOCKED","RECONCILIATION_REQUIRED","DISABLED"].indexOf(v)>=0)?"bad":(["RUNNING","CLAIMED","WARNING","READY","DISPATCHING"].indexOf(v)>=0)?"warn":"";
    return '<span class="status '+cls+'">'+esc(v)+'</span>';
  }
  function safeIssueLink(url,label){
    try{var u=new URL(url);if(u.protocol==="https:"&&u.hostname==="github.com"&&/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+\/?$/.test(u.pathname)){return '<a class="link" target="_blank" rel="noopener noreferrer" href="'+esc(u.href)+'">'+esc(label||u.pathname)+'</a>';}}catch(e){}
    return esc(label||url||"—");
  }
  async function api(path,options){
    var opts=options||{};opts.credentials="same-origin";opts.headers=opts.headers||{};
    if(opts.body){opts.headers["Content-Type"]="application/json";}
    if(opts.method&&opts.method!=="GET"&&csrfToken){opts.headers["X-CSRF-Token"]=csrfToken;}
    var response=await fetch(path,opts);var data={};try{data=await response.json();}catch(e){}
    if(!response.ok){throw new Error(data.error||("Request failed ("+response.status+")"));}
    return data;
  }
  function showAuth(setup){
    byId("shell").classList.add("hidden");byId("auth-view").classList.remove("hidden");
    byId("auth-title").textContent=setup?"Set up local operator access":"Local operator access";
    byId("auth-subtitle").textContent=setup?"Enter the one-time token printed by the Control Center setup command and choose a strong password.":"Sign in to inspect Bridge operations.";
    byId("bootstrap-field").classList.toggle("hidden",!setup);byId("confirm-field").classList.toggle("hidden",!setup);
    byId("password").autocomplete=setup?"new-password":"current-password";
    byId("auth-submit").textContent=setup?"Create local account":"Sign in";
    byId("auth-error").textContent="";
    byId("auth-form").dataset.mode=setup?"setup":"login";
  }
  async function afterAuth(){
    var session=await api("/api/session");csrfToken=session.csrfToken||"";
    byId("auth-view").classList.add("hidden");byId("shell").classList.remove("hidden");
    await navigate("dashboard");
    connectEvents();
  }
  function connectEvents(){
    if(eventSource)eventSource.close();
    eventSource=new EventSource("/api/events");
    eventSource.onopen=function(){
      if(eventSourceHasOpened){
        navigate(currentPage).catch(showError);
      }
      eventSourceHasOpened=true;
    };
    eventSource.addEventListener("refresh",function(){
      var now=Date.now();
      if(now-lastStreamRefreshAt<1500)return;
      lastStreamRefreshAt=now;
      navigate(currentPage).catch(showError);
    });
    eventSource.addEventListener("unavailable",function(){
      byId("page-title").textContent=(titles[currentPage]||"Overview")+" · reconnecting";
    });
    eventSource.onerror=function(){
      byId("page-title").textContent=(titles[currentPage]||"Overview")+" · reconnecting";
    };
  }
  async function start(){
    var state=await api("/api/auth/status");
    if(!state.configured){showAuth(true);return;}
    try{await afterAuth();}catch(e){showAuth(false);}
  }
  byId("auth-form").addEventListener("submit",async function(event){
    event.preventDefault();var mode=event.currentTarget.dataset.mode;
    var password=byId("password").value;
    try{
      if(mode==="setup"){
        if(password.length<14)throw new Error("Use a password with at least 14 characters.");
        if(password!==byId("confirm-password").value)throw new Error("The passwords do not match.");
        await api("/api/auth/setup",{method:"POST",body:JSON.stringify({token:byId("bootstrap-token").value,password:password})});
      }else{
        await api("/api/auth/login",{method:"POST",body:JSON.stringify({password:password})});
      }
      await afterAuth();
    }catch(e){byId("auth-error").textContent=e.message;}
  });
  function renderTable(headers,rows,empty){
    if(!rows.length)return '<div class="empty">'+esc(empty||"No records found.")+'</div>';
    return '<div class="table-wrap"><table><thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>';}).join("")+'</tr></thead><tbody>'+rows.join("")+'</tbody></table></div>';
  }
  function taskRows(tasks){
    return tasks.map(function(t){return '<tr data-task="'+esc(t.id)+'"><td><div class="row-title">'+esc(t.title)+'</div><small class="muted">'+esc(t.projectId)+' · #'+esc(t.issueNumber)+'</small></td><td>'+badge(t.status)+'</td><td>'+esc(t.author)+'</td><td>'+esc(t.updatedAt||t.createdAt||"—")+'</td><td>'+safeIssueLink(t.issueUrl,"Open issue")+'</td></tr>';});
  }
  async function navigate(page){
    currentPage=page;byId("page-title").textContent=titles[page]||"Overview";
    document.querySelectorAll(".nav button").forEach(function(b){b.classList.toggle("active",b.dataset.page===page);});
    byId("content").innerHTML='<div class="empty">Loading '+esc(titles[page]||page)+'…</div>';
    if(page==="dashboard")return renderDashboard();
    if(page==="projects")return renderProjects();
    if(page==="github")return renderGitHub();
    if(page==="tasks")return renderTasks();
    if(page==="review")return renderReview();
    if(page==="activity")return renderActivity();
    if(page==="settings")return renderSettings();
  }
  async function renderDashboard(){
    var d=await api("/api/dashboard");cachedTasks=d.recentTasks||[];
    var gates=d.gates||{};
    var html='<div class="notice">Autonomous task execution is not started by this Control Center. The generic worker and GitHub intake remain independently gated. The dedicated intake dispatcher is not yet connected to the generalized Windows Sandbox task runner.</div>';
    html+='<div class="grid">';
    html+='<div class="card"><div class="metric-label">Projects</div><div class="metric">'+esc(d.counts.projects)+'</div></div>';
    html+='<div class="card"><div class="metric-label">Tasks in latest page</div><div class="metric">'+esc(d.counts.tasksReturned)+'</div></div>';
    html+='<div class="card"><div class="metric-label">Open intake claims</div><div class="metric">'+esc(d.counts.intakeClaims)+'</div></div>';
    html+='<div class="card"><div class="metric-label">Active executions</div><div class="metric">'+esc(d.counts.activeExecutions)+'</div></div></div>';
    html+='<div class="section"><div class="section-head"><h2>Execution gates</h2><span class="muted">Read from bridge.config.json</span></div><div class="grid">';
    html+='<div class="card"><div class="metric-label">Generic worker</div><div style="margin-top:10px">'+badge(gates.workerEnabled?"ENABLED":"DISABLED")+'</div><p class="muted">Existing generic worker policy.</p></div>';
    html+='<div class="card"><div class="metric-label">GitHub intake gate</div><div style="margin-top:10px">'+badge(gates.githubIntakeEnabled?"ENABLED":"DISABLED")+'</div><p class="muted">Separate opt-in configuration.</p></div>';
    html+='<div class="card"><div class="metric-label">Intake runtime</div><div style="margin-top:10px">'+badge(d.services.intake.available?"AVAILABLE":"NOT WIRED")+'</div><p class="muted">'+esc(d.services.intake.reason)+'</p></div>';
    html+='<div class="card"><div class="metric-label">Web binding</div><div style="margin-top:10px">'+badge("LOOPBACK ONLY")+'</div><p class="muted">127.0.0.1 · authenticated local session</p></div></div></div>';
    html+='<div class="section"><div class="section-head"><h2>Recent tasks</h2><span class="muted">Newest persisted tasks</span></div>'+renderTable(["Task","Status","Author","Updated","GitHub"],taskRows(cachedTasks),"No tasks have been recorded yet.")+'</div>';
    html+='<p class="footer">Data snapshot: '+esc(d.generatedAt)+'</p>';
    byId("content").innerHTML=html;wireTaskRows();
  }
  async function renderProjects(){
    var d=await api("/api/projects");
    var rows=d.projects.map(function(p){
      var next=p.state==="active"?"disabled":"active";
      return '<tr><td><div class="row-title">'+esc(p.name)+'</div><small class="muted">'+esc(p.id)+'</small></td><td>'+esc(p.repository)+'</td><td>'+badge(p.state)+'</td><td>'+esc((p.allowedAuthors||[]).join(", "))+'</td><td><button class="project-state" data-project="'+esc(p.id)+'" data-state="'+next+'">'+(next==="active"?"Enable":"Disable")+'</button></td></tr>';
    });
    byId("content").innerHTML='<div class="section-head"><h2>Registered projects</h2><span class="muted">Project registry · no local paths exposed</span></div>'+renderTable(["Project","Repository","State","Allowed authors","Action"],rows,"No projects are registered. Add a project using the existing CLI workflow.");
    document.querySelectorAll("button.project-state").forEach(function(button){
      button.addEventListener("click",async function(){
        try{
          await api("/api/projects/"+encodeURIComponent(button.dataset.project)+"/state",{method:"POST",body:JSON.stringify({state:button.dataset.state})});
          await renderProjects();
        }catch(error){showError(error);}
      });
    });
  }
  async function renderGitHub(){
    var pair=await Promise.all([api("/api/intake-claims"),api("/api/intake/status")]);
    var d=pair[0],status=pair[1];
    var startEnabled=Boolean(status.enabled&&status.dispatcherReady&&!status.running);
    var controls=status.running
      ? '<button id="stop-intake">Stop automatic intake</button>'
      : '<button id="start-intake" class="primary" '+(startEnabled?'':'disabled')+'>Start automatic intake</button>';
    var reason=status.reason?'<p class="muted">'+esc(status.reason)+'</p>':'<p class="muted">Sandbox dispatcher reports ready. Starting intake will poll only trusted repositories and Issues bearing kilo:ready.</p>';
    var rows=d.claims.map(function(c){return '<tr><td><div class="row-title">'+esc(c.repositoryFullName)+' #'+esc(c.issueNumber)+'</div><small class="muted">'+esc(c.projectId)+'</small></td><td>'+badge(c.status)+'</td><td>'+esc(c.updatedAt)+'</td><td>'+esc(c.taskId||"—")+'</td><td>'+esc(c.lastError||"—")+'</td></tr>';});
    var html='<div class="card"><div class="section-head"><h2>Automatic GitHub intake</h2>'+badge(status.running?"RUNNING":status.enabled?"ENABLED · STOPPED":"DISABLED")+'</div>';
    html+='<div class="detail-grid"><div><div class="kv"><span>Intake gate</span>'+badge(status.enabled?"ENABLED":"DISABLED")+'</div><div class="kv"><span>Sandbox dispatcher</span>'+badge(status.dispatcherReady?"READY":"NOT READY")+'</div><div class="kv"><span>Trusted repositories</span><span>'+esc((status.repositories||[]).join(", ")||"None configured")+'</span></div></div><div><p class="muted">The service starts only after an explicit operator action. Opening or refreshing this page never polls GitHub.</p>'+reason+controls+'</div></div></div>';
    html+='<div class="notice">Each eligible Issue is claimed once, validated against the repository and author allowlists, and executed only through the isolated Sandbox dispatcher. Uncertain outcomes are held for reconciliation rather than retried.</div>';
    html+='<div class="section-head"><h2>Persisted intake claims</h2><span class="muted">'+esc(d.claims.length)+' returned</span></div>'+renderTable(["Repository / Issue","State","Updated","Task","Last error"],rows,"No intake claims have been recorded.");
    byId("content").innerHTML=html;
    var startButton=byId("start-intake");
    if(startButton)startButton.addEventListener("click",async function(){
      startButton.disabled=true;
      try{await api("/api/intake/start",{method:"POST",body:"{}"});await renderGitHub();}
      catch(error){showError(error);}
    });
    var stopButton=byId("stop-intake");
    if(stopButton)stopButton.addEventListener("click",async function(){
      stopButton.disabled=true;
      try{await api("/api/intake/stop",{method:"POST",body:"{}"});await renderGitHub();}
      catch(error){showError(error);}
    });
  }
  async function renderTasks(){
    var d=await api("/api/tasks?limit=100");cachedTasks=d.tasks||[];
    byId("content").innerHTML='<div class="section-head"><h2>Tasks</h2><span class="muted">Select a task row to inspect persisted detail</span></div>'+renderTable(["Task","Status","Author","Updated","GitHub"],taskRows(cachedTasks),"No tasks are recorded.")+'<div id="task-detail" class="section"></div>';
    wireTaskRows();
  }
  function wireTaskRows(){
    document.querySelectorAll("tr[data-task]").forEach(function(row){
      row.addEventListener("click",function(event){
        if(event.target && event.target.closest && event.target.closest("a"))return;
        showTask(row.dataset.task).catch(showError);
      });
    });
  }
  async function showTask(id){
    var d=await api("/api/tasks/"+encodeURIComponent(id));var t=d.task;
    var html='<div class="section-head"><h2>'+esc(t.title)+'</h2>'+badge(t.status)+'</div><div class="detail-grid"><div class="card">';
    html+='<div class="kv"><span>Project</span><span>'+esc(t.projectId)+'</span></div><div class="kv"><span>Issue</span><span>'+safeIssueLink(t.issueUrl,"#"+t.issueNumber)+'</span></div><div class="kv"><span>Author</span><span>'+esc(t.author)+'</span></div><div class="kv"><span>Attempt</span><span>'+esc(t.attempt)+'</span></div><div class="kv"><span>Execution ID</span><span>'+esc(t.executionId||"—")+'</span></div></div><div class="card"><strong>Task instructions</strong><pre>'+esc(t.body)+'</pre></div></div>';
    html+='<div class="section"><h2>Lifecycle</h2>'+renderTable(["From","To","Actor","Time","Reason"],d.transitions.map(function(x){return '<tr><td>'+esc(x.fromStatus||"—")+'</td><td>'+badge(x.toStatus)+'</td><td>'+esc(x.actor||"—")+'</td><td>'+esc(x.createdAt)+'</td><td>'+esc(x.reason||"—")+'</td></tr>'; }),"No lifecycle transitions recorded.")+'</div>';
    html+='<div class="section"><h2>Executions</h2>'+renderTable(["Execution","Status","Started","Exit","Kilo"],d.executions.map(function(x){return '<tr><td>'+esc(x.id)+'</td><td>'+badge(x.status)+'</td><td>'+esc(x.startTime)+'</td><td>'+esc(x.exitCode===undefined?"—":x.exitCode)+'</td><td>'+esc(x.kiloVersion||"—")+'</td></tr>'; }),"No executions recorded.")+'</div>';
    var panel=byId("task-detail");
    if(!panel){panel=document.createElement("div");panel.id="task-detail";byId("content").appendChild(panel);}
    panel.innerHTML=html;
  }
  async function renderReview(){
    var d=await api("/api/tasks?limit=200");
    var tasks=(d.tasks||[]).filter(function(t){return ["REPORT_READY","BLOCKED","FAILED","CHANGES_REQUESTED","PUBLISH_APPROVED"].indexOf(t.status)>=0;});
    byId("content").innerHTML='<div class="notice">Review is read-only in this milestone. Approvals, publishing, pull requests, and merges are not performed from this page.</div><div class="section-head"><h2>Tasks requiring attention</h2><span class="muted">Persisted review states</span></div>'+renderTable(["Task","Status","Author","Updated","GitHub"],taskRows(tasks),"No tasks currently require review.") ;
    wireTaskRows();
  }
  async function renderActivity(){
    var d=await api("/api/audit");
    var rows=d.events.map(function(x){return '<tr><td>'+esc(x.createdAt)+'</td><td>'+esc(x.action)+'</td><td>'+esc(x.actor||"—")+'</td><td>'+esc(x.projectId||"—")+'</td></tr>';});
    byId("content").innerHTML='<div class="section-head"><h2>Audit history</h2><span class="muted">Sensitive detail fields are not exposed</span></div>'+renderTable(["Time","Action","Actor","Project"],rows,"No audit events recorded.");
  }
  async function renderSettings(){
    var d=await api("/api/settings");var g=d.gates;var s=d.sandbox||{};var att=d.runtimeAttestation||{};
    var repositories=(g.githubIntakeAllowedRepositories||[]).join("\n");
    var attestationStatus=String(att.state||"NOT_ATTESTED").toUpperCase();
    var html='<div class="notice">The one-time runtime verification runs a harmless task in a disposable Bridge-owned folder. It does not process a GitHub Issue, use a registered project, or enable any automation gate. The provider API-key value remains in the Bridge process environment and is never submitted to this page.</div>';
    html+='<div class="detail-grid">';
    html+='<div class="card"><h2>Runtime attestation</h2><div class="kv"><span>Attestation status</span>'+badge(attestationStatus)+'</div><div class="kv"><span>Reason</span><span class="muted">'+esc(att.reason||"No attestation has been recorded.")+'</span></div><div class="kv"><span>Verified Kilo</span><span>'+esc(att.kiloVersion||"—")+'</span></div><div class="kv"><span>Windows Sandbox</span><span>'+esc(att.sandboxVersion||"—")+'</span></div><div class="kv"><span>Provider model</span><span>'+esc(att.providerModelId||"—")+'</span></div><div class="kv"><span>API key variable</span><span>'+esc(att.providerApiKeyEnvironmentName||"—")+' · '+badge(att.providerApiKeyPresent?"AVAILABLE":"NOT DETECTED")+'</span></div><div class="kv"><span>Provider requests</span><span>'+esc(att.providerRequests===undefined?"—":att.providerRequests)+'</span></div><div class="kv"><span>Native tool</span><span>'+esc(att.verifiedTool||"—")+'</span></div><div class="kv"><span>Attested at</span><span>'+esc(att.attestedAt||"—")+'</span></div><div class="kv"><span>Expires at</span><span>'+esc(att.expiresAt||"—")+'</span></div><div class="kv"><span>Marker SHA-256</span><span class="muted" style="overflow-wrap:anywhere">'+esc(att.markerSha256||"—")+'</span></div>';
    if(att.state==="RUNNING"){
      html+='<button disabled>Sandbox verification running…</button>';
    }else if(!att.valid){
      html+='<button id="run-sandbox-attestation" class="primary">Run one-time Sandbox verification</button>';
    }else{
      html+='<p class="success">The current runtime identity is attested. No further verification run is needed until expiry or a bound runtime setting changes.</p>';
    }
    html+='<p class="muted">A successful attestation expires after 24 hours and is invalidated by a change to Kilo, Windows Sandbox, provider settings, API-key environment presence, Node, or the runner contract.</p></div>';
    html+='<div class="card"><h2>GitHub intake</h2><div class="kv"><span>Intake gate</span>'+badge(g.githubIntakeEnabled?"ENABLED":"DISABLED")+'</div><div class="kv"><span>Sandbox execution gate</span>'+badge(g.sandboxExecutionEnabled?"ENABLED":"DISABLED")+'</div><div class="kv"><span>Dispatcher prerequisites</span>'+badge(d.intakeRuntimeAvailable?"READY":"NOT READY")+'</div><div class="kv"><span>Runtime status</span><span class="muted">'+esc(d.intakeRuntimeReason||"Ready for operator review")+'</span></div><div class="field"><label for="trusted-repositories">Trusted repositories (one owner/repo per line)</label><textarea id="trusted-repositories" rows="5" style="width:100%;border:1px solid var(--line);background:#0a1324;color:var(--text);border-radius:9px;padding:11px">'+esc(repositories)+'</textarea></div><div class="field"><label for="poll-interval">Polling interval in milliseconds (1,000–3,600,000)</label><input id="poll-interval" type="number" min="1000" max="3600000" step="1000" value="'+esc(d.pollIntervalMs)+'"></div><button id="save-intake-settings" class="primary">Save repository and polling settings</button>';
    if(att.valid && !g.sandboxExecutionEnabled){
      html+='<div class="field"><button id="enable-sandbox-gate">Enable Windows Sandbox execution</button></div>';
    }
    if(att.valid && g.sandboxExecutionEnabled && !g.githubIntakeEnabled &&
       g.ghEnabled && g.kiloEnabled && (g.githubIntakeAllowedRepositories||[]).length>0 && d.intakeRuntimeAvailable){
      html+='<div class="field"><button id="enable-intake-gate">Enable dedicated GitHub intake</button></div>';
    }
    if(g.githubIntakeEnabled){
      html+='<div class="field"><p class="muted">Dedicated intake is enabled as a configuration gate. Use the GitHub intake panel to explicitly Start or Stop polling; enabling the gate does not start it automatically.</p></div>';
    }
    html+='</div>';
    html+='<div class="card"><h2>Sandbox runtime prerequisites</h2><div class="kv"><span>Standalone Kilo executable</span>'+badge(s.kiloExecutableConfigured?"CONFIGURED":"MISSING")+'</div><div class="kv"><span>Configured executable</span><span class="muted">'+esc(s.kiloExecutableName||"Not configured")+'</span></div><div class="kv"><span>Provider API key</span>'+badge(s.providerApiKeyPresent?"AVAILABLE":"NOT DETECTED")+'</div><div class="field"><label for="sandbox-kilo-exe">Standalone kilo.exe absolute path</label><input id="sandbox-kilo-exe" type="text" value="" placeholder="'+esc(s.kiloExecutableName?"Currently configured: "+s.kiloExecutableName:"C:\\\\Path\\\\To\\\\kilo.exe")+'"><label><input id="sandbox-kilo-exe-clear" type="checkbox"> Clear custom path and use KILO_SANDBOX_EXE</label></div><div class="field"><label for="sandbox-provider-url">OpenAI-compatible provider base URL</label><input id="sandbox-provider-url" type="url" value="'+esc(s.providerBaseUrl||"")+'" placeholder="https://provider.example/v1"></div><div class="field"><label for="sandbox-provider-model">Upstream provider model ID</label><input id="sandbox-provider-model" type="text" value="'+esc(s.providerModelId||"")+'" placeholder="model-name"></div><div class="field"><label for="sandbox-api-env">API key environment variable name</label><input id="sandbox-api-env" type="text" value="'+esc(s.providerApiKeyEnv||"")+'" placeholder="KILO_BRIDGE_PROVIDER_API_KEY"></div><p class="muted">Set the variable value in the Windows environment before starting the Bridge. The secret itself is never submitted to this page or saved in bridge.config.json. Restart the Bridge process after changing the environment value.</p><div class="field"><label for="sandbox-api-header">API key header</label><input id="sandbox-api-header" type="text" value="'+esc(s.providerApiKeyHeader||"Authorization")+'"></div><div class="field"><label for="sandbox-api-prefix">API key prefix</label><input id="sandbox-api-prefix" type="text" value="'+esc(s.providerApiKeyPrefix||"Bearer ")+'"></div><div class="field"><label><input id="gh-enabled" type="checkbox" '+(g.ghEnabled?"checked":"")+'> GitHub integration prerequisite enabled</label></div><div class="field"><label><input id="kilo-enabled" type="checkbox" '+(g.kiloEnabled?"checked":"")+'> Kilo integration prerequisite enabled</label></div><button id="save-sandbox-settings" class="primary">Save Sandbox and prerequisite settings</button></div>';
    html+='<div class="card"><h2>Execution safeguards</h2><div class="kv"><span>Generic worker</span>'+badge(g.workerEnabled?"ENABLED":"DISABLED")+'</div><div class="kv"><span>Dedicated GitHub intake</span>'+badge(g.githubIntakeEnabled?"ENABLED":"DISABLED")+'</div><div class="kv"><span>Windows Sandbox runner</span>'+badge(g.sandboxExecutionEnabled?"ENABLED":"DISABLED")+'</div><p class="muted">The legacy generic worker cannot be enabled from this workflow. Dedicated intake is separate, claim-bound, and never falls back to host Kilo.</p><button id="disable-automation">Keep all execution gates disabled</button></div></div><div id="settings-message" class="footer"></div>';
    byId("content").innerHTML=html;
    if(byId("run-sandbox-attestation")){
      byId("run-sandbox-attestation").addEventListener("click",async function(){
        try{
          var started=await api("/api/sandbox/attestation/verify",{method:"POST",body:"{}"});
          byId("settings-message").textContent="Disposable Sandbox verification started. It does not process GitHub work.";
          for(var attempt=0;attempt<220;attempt++){
            await new Promise(function(resolve){setTimeout(resolve,3000);});
            var status=await api("/api/sandbox/attestation");
            if(status.state!=="RUNNING"){
              await renderSettings();
              byId("settings-message").textContent=status.valid?"Sandbox runtime attestation succeeded and is valid for 24 hours.":"Sandbox runtime verification ended: "+(status.reason||status.state);
              return;
            }
          }
          byId("settings-message").textContent="Verification is still running. Refresh Settings to inspect its current status.";
        }catch(error){byId("settings-message").textContent=error.message||String(error);}
      });
    }
    if(byId("enable-sandbox-gate")){
      byId("enable-sandbox-gate").addEventListener("click",async function(){
        try{
          await api("/api/settings",{method:"POST",body:JSON.stringify({sandboxExecutionEnabled:true})});
          await renderSettings();
          byId("settings-message").textContent="Windows Sandbox execution gate enabled. GitHub intake remains disabled.";
        }catch(error){byId("settings-message").textContent=error.message||String(error);}
      });
    }
    if(byId("enable-intake-gate")){
      byId("enable-intake-gate").addEventListener("click",async function(){
        try{
          await api("/api/settings",{method:"POST",body:JSON.stringify({githubIntakeEnabled:true})});
          await renderSettings();
          byId("settings-message").textContent="Dedicated GitHub intake gate enabled. Polling has not started; use the intake Start control explicitly.";
        }catch(error){byId("settings-message").textContent=error.message||String(error);}
      });
    }
    byId("save-intake-settings").addEventListener("click",async function(){
      try{
        var repos=byId("trusted-repositories").value.split(/\\r?\\n/).map(function(x){return x.trim();}).filter(Boolean);
        var interval=Number(byId("poll-interval").value);
        await api("/api/settings",{method:"POST",body:JSON.stringify({githubIntakeAllowedRepositories:repos,pollIntervalMs:interval})});
        await renderSettings();
        byId("settings-message").textContent="Repository and polling settings saved and audited.";
      }catch(error){byId("settings-message").textContent=error.message||String(error);}
    });
    byId("save-sandbox-settings").addEventListener("click",async function(){
      try{
        var payload={
          sandboxProviderBaseUrl:byId("sandbox-provider-url").value.trim(),
          sandboxProviderModelId:byId("sandbox-provider-model").value.trim(),
          sandboxProviderApiKeyEnv:byId("sandbox-api-env").value.trim(),
          sandboxProviderApiKeyHeader:byId("sandbox-api-header").value.trim(),
          sandboxProviderApiKeyPrefix:byId("sandbox-api-prefix").value,
          ghEnabled:byId("gh-enabled").checked,
          kiloEnabled:byId("kilo-enabled").checked
        };
        var executablePath=byId("sandbox-kilo-exe").value.trim();
        if(executablePath){payload.sandboxKiloExePath=executablePath;}
        else if(byId("sandbox-kilo-exe-clear").checked){payload.sandboxKiloExePath="";}
        await api("/api/settings",{method:"POST",body:JSON.stringify(payload)});
        await renderSettings();
        byId("settings-message").textContent="Sandbox prerequisites saved and audited. Execution gates are unchanged.";
      }catch(error){byId("settings-message").textContent=error.message||String(error);}
    });
    byId("disable-automation").addEventListener("click",async function(){
      try{
        await api("/api/settings",{method:"POST",body:JSON.stringify({githubIntakeEnabled:false,workerEnabled:false,sandboxExecutionEnabled:false})});
        await renderSettings();
        byId("settings-message").textContent="All execution gates are disabled.";
      }catch(error){byId("settings-message").textContent=error.message||String(error);}
    });
  }
  document.querySelectorAll(".nav button").forEach(function(b){b.addEventListener("click",function(){navigate(b.dataset.page).catch(showError);});});
  byId("refresh").addEventListener("click",function(){navigate(currentPage).catch(showError);});
  byId("logout").addEventListener("click",async function(){if(eventSource){eventSource.close();eventSource=null;}try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch(e){}csrfToken="";eventSourceHasOpened=false;showAuth(false);});
  function showError(error){byId("content").innerHTML='<div class="notice">'+esc(error.message||error)+'</div>';}
  start().catch(function(error){showAuth(false);byId("auth-error").textContent=error.message||String(error);});
})();
</script>
</body>
</html>`;
