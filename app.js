const state = {
  projects: [],
  options: [],
  selectedId: null,
};

const $ = (id) => document.getElementById(id);
const fmtPct = (value) => `${Math.round((value || 0) * 100)}%`;
const fmtCases = (project) => (project.testCaseBase > 0 ? `${project.executedCases}/${project.testCaseBase}` : "미집계");
const KST_TIME_ZONE = "Asia/Seoul";

function normalizeDateInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    return `${text.replace(" ", "T")}+09:00`;
  }
  return text;
}

function formatKstDateTime(value) {
  if (!value) return "-";
  const date = new Date(normalizeDateInput(value));
  if (Number.isNaN(date.getTime())) return String(value).replace("T", " ");
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

function scoreClass(score) {
  if (score >= 85) return "good";
  if (score >= 70) return "warn";
  return "bad";
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3600);
}

function selectedFilterId() {
  return $("projectSelect").value || "";
}

function filteredProjects() {
  const selected = selectedFilterId();
  const query = $("search").value.trim().toLowerCase();
  return state.projects.filter((project) => {
    if (selected && project.id !== selected) return false;
    const haystack = `${project.project} ${project.name} ${project.category}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function readApiJson(response, fallbackMessage) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${fallbackMessage}: 서버가 JSON이 아닌 응답을 반환했습니다.`);
  }
  if (!response.ok) {
    throw new Error(data.message || fallbackMessage);
  }
  return data;
}

async function loadProjectOptions() {
  const response = await fetch("/api/projects");
  const data = await readApiJson(response, "프로젝트 목록 조회 실패");
  state.options = data.projects;
  $("projectSelect").innerHTML = [
    '<option value="">계산할 프로젝트 선택</option>',
    ...data.projects.map(
      (project) =>
        `<option value="${project.id}">${escapeHtml(project.category)} · ${escapeHtml(project.project)}</option>`
    ),
  ].join("");
}

async function loadDashboard() {
  const response = await fetch("/api/hqi");
  const data = await readApiJson(response, "저장 결과 조회 실패");
  state.projects = data.projects;
  state.selectedId = selectedFilterId() || state.selectedId || data.projects[0]?.id || null;
  renderSummary(data.summary);
  renderScatter();
  renderFunnel();
  renderRegularTrend(data.regularTrend || []);
  renderRows();
  renderDetail();
  $("generatedAt").textContent = `저장된 계산 결과 기준 ${formatKstDateTime(data.generatedAt)}`;
}

async function calculateSelected() {
  const projectId = $("projectSelect").value;
  if (!projectId) {
    showToast("계산할 프로젝트를 선택하세요.");
    return;
  }

  $("calculate").disabled = true;
  $("calculate").textContent = "계산 중";
  try {
    const response = await fetch("/api/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await readApiJson(response, "계산 실패");

    state.selectedId = data.project.id;
    state.projects = data.dashboard.projects;
    renderSummary(data.dashboard.summary);
    renderScatter();
    renderFunnel();
    renderRegularTrend(data.dashboard.regularTrend || []);
    renderRows();
    renderDetail();
    $("generatedAt").textContent = `저장된 계산 결과 기준 ${formatKstDateTime(data.dashboard.generatedAt)}`;
    showToast(data.updated ? "계산 결과를 DB에 저장했습니다." : "변경 사항이 없어 저장된 결과를 표시합니다.");
  } catch (error) {
    showToast(error.message);
  } finally {
    $("calculate").disabled = false;
    $("calculate").textContent = "계산";
  }
}

async function calculateAllProjects() {
  $("calculateAll").disabled = true;
  $("calculateAll").textContent = "전체 계산 중";
  try {
    const response = await fetch("/api/calculate-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await readApiJson(response, "전체 프로젝트 계산 실패");

    state.projects = data.dashboard.projects;
    state.selectedId = selectedFilterId() || state.projects[0]?.id || null;
    renderSummary(data.dashboard.summary);
    renderScatter();
    renderFunnel();
    renderRegularTrend(data.dashboard.regularTrend || []);
    renderRows();
    renderDetail();
    $("generatedAt").textContent = `저장된 계산 결과 기준 ${formatKstDateTime(data.dashboard.generatedAt)}`;
    const errorText = data.errorCount ? `, 실패 ${data.errorCount}개` : "";
    showToast(`전체 계산 완료: 신규/갱신 ${data.updatedCount}개, 저장 결과 재사용 ${data.reusedCount}개${errorText}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    $("calculateAll").disabled = false;
    $("calculateAll").textContent = "전체 프로젝트 추이 계산";
  }
}

function renderSummary(summary) {
  $("avgScore").textContent = summary.averageScore;
  $("projectCount").textContent = summary.projectCount;
  $("issueCount").textContent = summary.issueCount;
  $("testCaseCount").textContent = summary.testCaseCount;
  $("lowestScore").textContent = summary.lowestScore;
}

function renderRows() {
  const rows = filteredProjects();
  const selected = selectedFilterId();
  const emptyMessage = selected
    ? "선택한 프로젝트의 저장된 계산 결과가 없습니다. 상단 계산 버튼을 선택하세요."
    : "저장된 계산 결과가 없습니다. 상단에서 프로젝트를 선택하고 계산하세요.";

  $("projectRows").innerHTML = rows.length
    ? rows.map(renderProjectRow).join("")
    : `<tr><td colspan="9" class="empty">${emptyMessage}</td></tr>`;

  document.querySelectorAll("#projectRows tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      renderRows();
      renderScatter();
      renderDetail();
    });
  });
}

function renderProjectRow(project) {
  return `
    <tr data-id="${project.id}" class="${project.id === state.selectedId ? "selected" : ""}">
      <td>
        <strong>${escapeHtml(project.project)}</strong><br />
        <small>${escapeHtml(project.category)} · ${escapeHtml(project.date || "-")}</small>
      </td>
      <td><span class="score ${scoreClass(project.score)}">${project.score}</span></td>
      <td class="metric">${fmtPct(project.TPR)}</td>
      <td class="metric">${fmtPct(project.DQS)}</td>
      <td class="metric">${fmtPct(project.BOR)}</td>
      <td class="metric">${fmtPct(project.BFR)}</td>
      <td class="metric">${fmtCases(project)}</td>
      <td class="metric">${project.bugCount} / 미해결 ${project.openBugCount}</td>
      <td>${escapeHtml(project.status || "-")}</td>
    </tr>
  `;
}

function renderScatter() {
  const width = 620;
  const height = 380;
  const pad = 48;
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;
  const ticks = [0, 25, 50, 75, 100];
  const toX = (value) => pad + value * plotWidth;
  const toY = (value) => height - pad - value * plotHeight;
  const grid = ticks
    .map((tick) => {
      const ratio = tick / 100;
      return `
        <line x1="${toX(ratio)}" y1="${pad}" x2="${toX(ratio)}" y2="${height - pad}" class="grid" />
        <line x1="${pad}" y1="${toY(ratio)}" x2="${width - pad}" y2="${toY(ratio)}" class="grid" />
        <text x="${toX(ratio)}" y="${height - 16}" class="axisText" text-anchor="middle">${tick}</text>
        <text x="28" y="${toY(ratio) + 4}" class="axisText" text-anchor="middle">${tick}</text>
      `;
    })
    .join("");
  const visibleProjects = filteredProjects();
  const dots = visibleProjects
    .map((project) => {
      const selected = project.id === state.selectedId ? " selectedDot" : "";
      return `
        <g class="dotGroup${selected}" data-id="${project.id}">
          <circle cx="${toX(project.TPR)}" cy="${toY(project.DQS)}" r="${selected ? 8 : 6}" class="dot ${scoreClass(project.score)}" />
          <text x="${toX(project.TPR) + 10}" y="${toY(project.DQS) - 8}" class="dotLabel">${escapeHtml(project.project)}</text>
        </g>
      `;
    })
    .join("");

  $("scatterChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <rect x="${pad}" y="${pad}" width="${plotWidth}" height="${plotHeight}" class="plotBg" />
      ${grid}
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="axis" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="axis" />
      <text x="${width / 2}" y="${height - 4}" class="axisTitle" text-anchor="middle">TPR</text>
      <text x="14" y="${height / 2}" class="axisTitle vertical" text-anchor="middle">DQS</text>
      <circle cx="${toX(1)}" cy="${toY(1)}" r="7" class="target" />
      <text x="${toX(1) - 6}" y="${toY(1) - 12}" class="targetLabel" text-anchor="end">Target</text>
      ${dots}
    </svg>
  `;

  document.querySelectorAll(".dotGroup").forEach((dot) => {
    dot.addEventListener("click", () => {
      state.selectedId = dot.dataset.id;
      renderRows();
      renderScatter();
      renderDetail();
    });
  });
}

function renderFunnel() {
  const visibleProjects = filteredProjects();
  const buckets = [
    { label: "Excellent", range: "90+", min: 90, max: 101, className: "good" },
    { label: "Good", range: "80-89", min: 80, max: 90, className: "ok" },
    { label: "Watch", range: "70-79", min: 70, max: 80, className: "warn" },
    { label: "Risk", range: "0-69", min: 0, max: 70, className: "bad" },
  ].map((bucket) => ({
    ...bucket,
    count: visibleProjects.filter((project) => project.score >= bucket.min && project.score < bucket.max).length,
  }));
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  $("funnelChart").innerHTML = buckets
    .map((bucket) => {
      const width = Math.max(16, Math.round((bucket.count / maxCount) * 100));
      return `
        <div class="funnelRow">
          <div class="funnelMeta">
            <strong>${bucket.label}</strong>
            <span>${bucket.range}</span>
          </div>
          <div class="funnelBar ${bucket.className}" style="width: ${width}%">
            <span>${bucket.count}개</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderRegularTrend(trend) {
  $("regularTrend").innerHTML = trend.length
    ? trend
        .map(
          (item) => `
          <div class="trendRow">
            <span class="trendVersion">${escapeHtml(item.project)}</span>
            <div class="trendTrack">
              <div class="trendFill ${scoreClass(item.score)}" style="width: ${Math.max(2, item.score)}%"></div>
            </div>
            <span class="trendScore">${item.score}</span>
          </div>
        `
        )
        .join("")
    : '<div class="empty">5.18 이후 정기 업데이트 계산 결과가 없습니다.</div>';
}

function renderDetail() {
  const selected = selectedFilterId();
  const project =
    state.projects.find((item) => item.id === (selected || state.selectedId)) ||
    filteredProjects()[0];
  if (!project) {
    $("projectDetail").className = "empty";
    $("projectDetail").textContent = "프로젝트 행을 선택하세요.";
    return;
  }

  $("projectDetail").className = "";
  $("projectDetail").innerHTML = `
    <h3>${escapeHtml(project.project)}</h3>
    <div class="detailGrid">
      <div><span>HQI</span><strong>${project.score}</strong></div>
      <div><span>수행 TC</span><strong>${fmtCases(project)}</strong></div>
      <div><span>전체 결함</span><strong>${project.bugCount}</strong></div>
      <div><span>수정 완료</span><strong>${project.fixedCount}</strong></div>
    </div>
    <p>TC DB: ${formatTcDatabases(project.tcDatabases)}</p>
    <p>심각도: ${formatSeverity(project.severityCounts)}</p>
    <ul class="issueList">
      ${project.issues.length ? project.issues.map(renderIssue).join("") : "<li>매칭된 결함이 없습니다.</li>"}
    </ul>
  `;
}

function renderIssue(issue) {
  return `
    <li>
      <a href="${issue.url}" target="_blank" rel="noreferrer">${escapeHtml(issue.title || "제목 없음")}</a>
      <small>${escapeHtml(issue.status || "-")} · ${escapeHtml(issue.severity || "미지정")} · ${escapeHtml(issue.target || "-")}</small>
    </li>
  `;
}

function formatSeverity(counts) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return "없음";
  return entries.map(([key, value]) => `${escapeHtml(key)} ${value}`).join(", ");
}

function formatTcDatabases(databases) {
  if (!databases || !databases.length) return "없음";
  const visible = databases.slice(0, 8);
  const hiddenCount = databases.length - visible.length;
  const text = visible
    .map((database) => `${escapeHtml(database.title)} ${database.executedCases}/${database.caseCount}`)
    .join(", ");
  return hiddenCount > 0 ? `${text}, 외 ${hiddenCount}개` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

$("calculate").addEventListener("click", calculateSelected);
$("calculateAll").addEventListener("click", calculateAllProjects);
$("projectSelect").addEventListener("change", () => {
  state.selectedId = selectedFilterId() || state.projects[0]?.id || null;
  renderScatter();
  renderFunnel();
  renderRows();
  renderDetail();
});
$("search").addEventListener("input", renderRows);

Promise.all([loadProjectOptions(), loadDashboard()]).catch((error) => showToast(error.message));
