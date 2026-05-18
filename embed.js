const state = {
  projects: [],
  trend: [],
};

const $ = (id) => document.getElementById(id);
const fmtPct = (value) => `${Math.round((value || 0) * 100)}%`;
const fmtCases = (project) => (project.testCaseBase > 0 ? `${project.executedCases}/${project.testCaseBase}` : "미집계");

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

function filteredProjects() {
  const query = $("search").value.trim().toLowerCase();
  return state.projects.filter((project) => {
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

async function loadDashboard({ silent = false } = {}) {
  try {
    const response = await fetch("/api/hqi");
    const data = await readApiJson(response, "저장 결과 조회 실패");
    state.projects = data.projects;
    state.trend = data.regularTrend || [];
    renderRows();
    renderTrend();
    $("generatedAt").textContent = `저장된 계산 결과 기준 ${new Date(data.generatedAt).toLocaleString()}`;
  } catch (error) {
    if (!silent) showToast(error.message);
  }
}

function renderRows() {
  const rows = filteredProjects();
  $("projectRows").innerHTML = rows.length
    ? rows.map(renderProjectRow).join("")
    : '<tr><td colspan="9" class="empty">저장된 계산 결과가 없습니다.</td></tr>';
}

function renderTrend() {
  const items = state.trend;
  const maxScore = Math.max(1, ...items.map((item) => item.score || 0));
  $("trendChart").innerHTML = items.length
    ? items
        .map((item) => {
          const width = Math.max(2, Math.round(((item.score || 0) / maxScore) * 100));
          return `
            <div class="embedTrendRow">
              <span class="embedTrendVersion">${escapeHtml(item.project)}</span>
              <div class="embedTrendTrack">
                <div class="embedTrendFill ${scoreClass(item.score)}" style="width: ${width}%"></div>
              </div>
              <span class="embedTrendScore">${item.score}</span>
            </div>
          `;
        })
        .join("")
    : '<div class="empty">5.18 이후 정기 업데이트 계산 결과가 없습니다.</div>';
}

function renderProjectRow(project) {
  return `
    <tr>
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

$("search").addEventListener("input", renderRows);
loadDashboard();
window.setInterval(() => loadDashboard({ silent: true }), 300000);
