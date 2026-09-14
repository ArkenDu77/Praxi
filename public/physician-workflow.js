(function (root) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' }).format(new Date(value)) : 'Date non précisée';
  const requests = new WeakMap();
  const sources = item => item && item.source ? `${esc(item.source.label || 'Fiche patient')} · ${esc(date(item.source.at))}` : '';
  async function preparation(host, patientId, api) {
    if (!host) return;
    const request = {}; requests.set(host, request);
    host.hidden = !patientId;
    host.textContent = patientId ? 'Préparation du dossier…' : '';
    if (!patientId) return;
    try {
      const summary = await api('/api/patients/' + encodeURIComponent(patientId) + '/preparation');
      if (requests.get(host) !== request) return;
      const changed = summary.delta.filter(item => item.status !== 'INCHANGE');
      host.innerHTML = `<div class="wf-heading"><h2>${esc(summary.title)}</h2><small>Sources disponibles dans le dossier</small></div>
        <p class="wf-reason">${esc(summary.reason.text)}</p>
        <div class="wf-facts">${summary.facts.slice(0, 4).map(item => `<div><strong>${esc(item.label)}</strong><p>${esc(item.text)}</p></div>`).join('')}</div>
        ${summary.lastVisit ? `<p><strong>Dernière consultation · ${esc(date(summary.lastVisit.at))}</strong><br>${esc(summary.lastVisit.text)}</p>` : '<p class="muted">Aucune consultation antérieure enregistrée.</p>'}
        ${changed.length ? `<div class="wf-deltas">${changed.map(item => `<p><span class="wf-tag" data-status="${item.status}">${item.status === 'CONTRADICTOIRE' ? 'À vérifier' : item.status === 'NOUVEAU' ? 'Nouveau' : 'Modifié'}</span> <strong>${esc(item.label)}</strong> : ${esc(item.current || 'Non renseigné')}<br><small>Avant : ${esc(item.previous || 'Non renseigné')} · ${esc(date(item.at))}</small></p>`).join('')}</div>` : ''}
        ${summary.toVerify.length ? `<details><summary>Points à vérifier · ${summary.toVerify.length}</summary><ul>${summary.toVerify.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}
        <details><summary>Sources et documents récents</summary><p>${sources(summary.reason)}</p>${summary.newDocuments.map(doc => `<p>${esc(doc.title || doc.label)} · ${esc(date(doc.at))}</p>`).join('') || '<p>Aucun document plus récent.</p>'}${!summary.comparisonAvailable ? '<p>Pas de comparaison clinique datée disponible.</p>' : ''}</details>`;
    } catch (error) {
      if (requests.get(host) === request) host.textContent = 'Préparation indisponible : ' + error.message;
    }
  }

  async function mountScales(host, api, specialty) {
    if (!host) return;
    if (host.dataset.mounted) {
      const select = host.querySelector('[data-pack]');
      if (select && /algolog|douleur/i.test(specialty || '') && select.value !== 'algologie') {
        select.value = 'algologie';
        select.dispatchEvent(new Event('change'));
      }
      return;
    }
    host.dataset.mounted = '1';
    try {
      const { packs } = await api('/api/clinical/specialty-packs');
      host.innerHTML = `<label class="label">Cadre de la consultation<select class="select" data-pack><option value="">Spécialité du médecin</option>${packs.map(pack => `<option value="${esc(pack.id)}">${esc(pack.label)}</option>`).join('')}</select></label><div data-scales></div>`;
      const select = host.querySelector('[data-pack]');
      if (/algolog|douleur/i.test(specialty || '')) select.value = 'algologie';
      function draw() {
        const pack = packs.find(item => item.id === select.value);
        host.querySelector('[data-scales]').innerHTML = pack ? `<details class="wf-scales"><summary>Échelles et repères · ${esc(pack.label)}</summary><p>Renseignez seulement les réponses recueillies. Un item inconnu reste vide. Les résultats et interprétations seront proposés à la relecture.</p>${pack.scales.map(scale => `<fieldset data-scale="${esc(scale.id)}"><legend>${esc(scale.label)}</legend><a href="${esc(scale.source)}" target="_blank" rel="noopener">Référence de l’échelle</a><div class="wf-scale-grid">${scale.items.map((item, index) => `<label>${esc(item.label)}${item.requiresExam ? ' · examen' : ''}${item.kind === 'boolean' ? `<select class="select" data-scale-item="${index}" aria-label="${esc(scale.label + ' ' + item.label)}"><option value="">Non évalué</option><option value="true">Oui</option><option value="false">Non</option></select>` : `<input class="input" type="number" min="0" max="10" step="any" data-scale-item="${index}" aria-label="${esc(scale.label + ' ' + item.label)}" placeholder="0 à 10">`}</label>`).join('')}</div></fieldset>`).join('')}</details>` : '';
      }
      select.addEventListener('change', draw); draw();
    } catch (error) { delete host.dataset.mounted; host.textContent = 'Échelles indisponibles : ' + error.message; }
  }

  function scalePayload(host) {
    if (!host) return {};
    const pack = host.querySelector('[data-pack]');
    if (!pack || !pack.value) return {};
    const scaleInputs = {};
    host.querySelectorAll('[data-scale]').forEach(field => {
      scaleInputs[field.dataset.scale] = [...field.querySelectorAll('[data-scale-item]')].map(input => {
        if (input.value === '') return null;
        if (input.tagName === 'SELECT') return input.value === 'true';
        return Number.isFinite(Number(input.value)) ? Number(input.value) : null;
      });
    });
    return { specialtyPack: pack.value, scaleInputs };
  }

  function resetScales(host) {
    if (!host) return;
    host.querySelectorAll('[data-scale-item]').forEach(input => { input.value = ''; });
  }

  function packReview(pack) {
    if (!pack) return '';
    return `<details class="cv-fold" open><summary><span>${esc(pack.label)} · observations et calculs</span></summary><div class="cv-fold-body">${pack.scores.map(score => `<p><strong>${esc(score.label)}</strong> : ${score.status === 'CALCULATED' ? `${Number(score.value.toFixed(2))}/${score.max} · calcul sur les réponses saisies` : 'Non calculable · réponses manquantes'} <a href="${esc(score.source)}" target="_blank" rel="noopener">Source</a></p>`).join('')}${pack.interpretations.map(item => `<p><strong>Interprétation proposée, à valider ci-dessous</strong><br>${esc(item.text)}<br><small>${esc(item.rationale)} ${esc(item.confidence)}</small></p>`).join('')}<p>À documenter : ${pack.missing.length ? pack.missing.map(item => esc(item.label)).join(' · ') : 'éléments spécifiques présents dans les notes'}</p></div></details>`;
  }
  root.ArkibaWorkflow = { preparation, mountScales, scalePayload, resetScales, packReview };
})(window);
(function (root) {
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const parisDay = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '';
  function connectionHealth(integration, now = Date.now()) {
    if (!integration) return { state: 'DISCONNECTED', label: 'Connectez votre agenda', action: true };
    if (integration.state === 'NEEDS_REAUTH') return { state: 'REAUTH_REQUIRED', label: 'Doctolib : reconnexion nécessaire', action: true };
    if (!['CONNECTED', 'TEMPORARILY_UNAVAILABLE'].includes(integration.state)) return { state: integration.state, label: 'Doctolib : connexion à terminer', action: true };
    const observed = Date.parse(integration.last_observed_at || '');
    if (integration.state !== 'CONNECTED' || !Number.isFinite(observed) || observed > now || now - observed > 10 * 60 * 1000) return { state: 'DEGRADED', label: 'Doctolib : vérification de session en attente', action: true };
    return { state: 'CONNECTED', label: 'Doctolib : session vérifiée récemment', action: false };
  }
  let sequence = 0;
  async function today(host, api, openEncounter, openIntegrations) {
    if (!host) return;
    const current = ++sequence;
    host.textContent = 'Préparation de votre journée…';
    const replies = await Promise.allSettled([api('/api/preconsult/encounters'), api('/api/preconsult/rendez-vous'), api('/api/integrations')]);
    if (sequence !== current) return;
    const day = parisDay(new Date().toISOString());
    const encounters = replies[0].status === 'fulfilled' ? replies[0].value.encounters || [] : [];
    const calls = replies[1].status === 'fulfilled' ? replies[1].value.calls || [] : [];
    const integrations = replies[2].status === 'fulfilled' ? replies[2].value.integrations || [] : [];
    const prepared = encounters.filter(item => parisDay(item.scheduled_start) === day);
    const waiting = calls.filter(item => item.sans_preconsultation && item.rendez_vous && parisDay(item.rendez_vous.starts_at) === day);
    const items = [...prepared.map(item => ({ id: item.encounter_id, patient: item.patient_name || 'Patient', at: item.scheduled_start, status: item.display_status || item.status || 'Dossier à relire' })), ...waiting.map(item => ({ patient: item.rendez_vous.patient || 'Patient', at: item.rendez_vous.starts_at, status: 'Pré-consultation à préparer' }))].sort((a,b) => a.at.localeCompare(b.at));
    const health = connectionHealth(integrations.find(item => String(item.kind).startsWith('doctolib')));
    host.innerHTML = `<div class="wf-today-health" data-health="${esc(health.state)}"><strong>${replies[2].status === 'rejected' ? 'État Doctolib indisponible' : esc(health.label)}</strong><button type="button" class="btn btn-ghost" data-today-integrations>Vérifier la connexion</button></div>
      ${replies.slice(0, 2).some(reply => reply.status === 'rejected') ? '<div class="wf-today-error" role="alert">Une partie de la journée est indisponible. Actualisez pour réessayer ; cette liste peut être incomplète.</div>' : ''}
      <div class="wf-today-counts"><div><b>${items.length}</b><span>rendez-vous visibles aujourd’hui</span></div><div><b>${prepared.length}</b><span>dossiers à relire</span></div><div><b>${waiting.length}</b><span>préparations en attente</span></div></div>
      <div class="wf-agenda">${items.map((item, index) => `<button type="button" class="wf-agenda-row" data-today-row="${index}"><time>${esc(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(item.at)))}</time><span><strong>${esc(item.patient)}</strong><small>${esc(item.status)}</small></span><span>Ouvrir →</span></button>`).join('') || '<p>Aucun rendez-vous du jour dans les données reçues. Vous pouvez ouvrir un patient ou consulter les pré-consultations.</p>'}</div>`;
    host.querySelector('[data-today-integrations]').addEventListener('click', openIntegrations);
    host.querySelectorAll('[data-today-row]').forEach(button => button.addEventListener('click', () => openEncounter(items[Number(button.dataset.todayRow)].id)));
  }
  Object.assign(root.ArkibaWorkflow, { today, connectionHealth });
})(window);
