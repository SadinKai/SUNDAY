'use strict';

/* ----------------------------- Help view ----------------------------- */
views.help = function () {
  const legacyMode = legacyCompatibilityMode();
  mount(`
    <div class="help">
      <div class="page-head"><h1>Help</h1><p>Everything you need to use SUNDAY Launcher.</p></div>

      <h2>What SUNDAY Launcher does</h2>
      <p>${legacyMode ? '<b>Multi-instance mode is active.</b> SUNDAY can launch one to three managed clients through its legacy compatibility path. This mode is not supported by Roblox.' : 'Multi-instance mode is disabled for this process. SUNDAY can prepare launch plans, but Roblox execution remains unavailable until the setting is enabled and SUNDAY restarts.'}</p>

      <h2>Quick start</h2>
      <div class="step"><div class="n">1</div><div>On <b>Accounts</b>, click <b>Add account</b>. SUNDAY Launcher opens a Tauri Roblox sign-in window and saves the account after Roblox sets the session.</div></div>
      <div class="step"><div class="n">2</div><div>Select up to three accounts, choose a place, person, or exact server, then click <b>Launch</b>.</div></div>
      <div class="step"><div class="n">3</div><div>Stay on <b>Launch</b> to follow each active client, its destination, state, and available actions.</div></div>

      <h2>Accounts</h2>
      <p>Accounts appear with avatar, name, presence, and useful session status. Saved sign-ins remain protected on this PC. Automated account creation is unavailable.</p>

      <h2>Command palette</h2>
      <p>Press <b>Ctrl+K</b> to search safe navigation, refresh, theme, diagnostics, and data-folder actions. Destructive process and update actions are not exposed there.</p>

      <h2>Watch people</h2>
      <p>On <b>People</b>, the eye button on a card or profile adds that person to the watch list. A background poll reports when they join or switch games, and <b>Plan join</b> creates per-account follow intents. Up to 20 people are stored locally.</p>

      <h2>Keep alive</h2>
      <p>When Keep alive is enabled, SUNDAY can rejoin an account after a client it launched closes unexpectedly. It never acts on an unrelated Roblox client.</p>

      <h2>Fill the emptiest servers</h2>
      <p>Filter servers by capacity and connection quality, then choose whether selected accounts should stay together or spread across available servers.</p>

      <h2>Sessions and appearance</h2>
      <p>Saved sessions can prepare the same account and target plan in one click. In <b>Settings · Appearance</b>, choose System, Dawn, or Eclipse.</p>

      <h2>Runtime modes</h2>
      <p>${legacyMode ? 'Multi-instance mode is enabled for this SUNDAY process and uses the legacy Roblox compatibility path. Open Diagnostics for implementation details.' : 'Multi-instance mode is disabled. Enable it in <b>Settings · Multi-instance</b>, save, and accept the restart prompt before launching Roblox.'}</p>

      <h2>Tools</h2>
      <ul>
        <li>Refresh updates the active-client list.</li>
        <li>Focus, End, and Restart are available only for clients SUNDAY launched. Other observed clients remain view-only.</li>
        <li><b>End all</b> and <b>Cleanup</b> are disabled.</li>
        <li>Keyboard: <b>Ctrl+K</b> opens the command palette, <b>Ctrl+1</b> through <b>Ctrl+9</b> jump straight to a section, <b>/</b> focuses search on Games and People, and <b>Esc</b> closes any dialog. SUNDAY Launcher reopens the section you last used.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <div class="faq">
        <details><summary>“Roblox not found”</summary><div class="a">Install Roblox, or open <b>Settings · Roblox location</b>, switch to <b>Manual path</b> and point SUNDAY Launcher at <code>RobloxPlayerBeta.exe</code>.</div></details>
        <details><summary>Why did Launch fail?</summary><div class="a">${legacyMode ? 'Legacy mode refuses a launch when classic Roblox is missing, Store Roblox is selected, or SUNDAY cannot safely prepare and verify an exact client slot.' : 'Roblox execution is disabled for this process. Enable Multi-instance mode and restart, then open Diagnostics and copy the sanitized launch report if retrying does not help.'}</div></details>
        <details><summary>An account shows “Session expired”</summary><div class="a">Roblox sessions expire over time. Click <b>Sign in again</b> on that account to refresh it.</div></details>
        <details><summary>Is my login safe?</summary><div class="a">Existing saved sessions remain local to this PC and are never shown in the UI.</div></details>
      </div>

      <h2>Use responsibly</h2>
      <p>Run only as many clients as your PC can handle, and follow Roblox's Terms of Use for the experiences you play.</p>
      <p style="margin-top:14px"><button class="btn sm" data-action="ext-link" data-url="https://www.roblox.com/download">${icon('box')} Get Roblox</button></p>

      <h2>About</h2>
      <p><b>SUNDAY Launcher</b><br>Created by SADINKAI</p>
    </div>
  `);
};
