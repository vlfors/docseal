<script lang="ts">
  import { formatTime } from "../i18n/language";
  import { language, t } from "../i18n/state.svelte";
  import type { ReportView } from "../report/view";
  import { clip, shortId } from "../text";
  import PackageText from "./PackageText.svelte";

  let { view }: { view: ReportView } = $props();

  const technical = $derived(
    (
      [
        ["packageId", view.technical.packageId],
        ["seal", view.technical.seal],
        ["merkleRoot", view.technical.merkleRoot],
        ["statementHash", view.technical.statementHash],
      ] as const
    ).filter((row): row is [(typeof row)[0], string] => row[1] !== undefined),
  );
</script>

<section class="report" data-overall={view.overall} aria-live="polite">
  <header class="verdict {view.overall}">
    <h2>{t().overall[view.overall].headline}</h2>
    <p>{t().overall[view.overall].explanation}</p>
  </header>

  <table class="axes">
    <tbody>
      {#each view.axes as row (row.axis)}
        <tr data-axis={row.axis} data-verdict={row.verdict} class={row.tone}>
          <th scope="row">
            {t().axes[row.axis].name}
            <span class="question">{t().axes[row.axis].question}</span>
          </th>
          <td class="value">{(t().verdicts[row.axis] as Record<string, string>)[row.verdict]}</td>
          <td class="detail">
            {#if row.detail.kind === "files"}
              {t().details.filesMatch(row.detail.ok, row.detail.total)}
            {:else if row.detail.kind === "signers"}
              {#each row.detail.signers as signer, i (i)}{i > 0 ? ", " : ""}<PackageText text={shortId(signer.id)} />{#if signer.role !== undefined}&nbsp;(<PackageText
                    text={signer.role}
                  />){/if}{/each}
            {:else if row.detail.kind === "reasons"}
              {#each row.detail.reasons as reason, i (i)}{i > 0 ? "; " : ""}<PackageText text={reason} />{/each}
            {:else if row.detail.kind === "attested"}
              {t().details.noLaterThan(formatTime(row.detail.at, language()))}
              {#if row.detail.confirmations !== undefined}
                ({t().details.confirmations(row.detail.confirmations)}{#if row.detail.source !== undefined}{`, ${t().details.via} `}<PackageText
                    text={row.detail.source}
                  />{/if})
              {/if}
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if view.hints.length > 0}
    <section class="hints">
      <h3>{t().sections.nextSteps}</h3>
      <ul>
        {#each view.hints as hint (hint)}
          <li data-hint={hint}>{t().hints[hint]}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if view.problemFiles.length > 0}
    <section>
      <h3>{t().sections.files}</h3>
      <ul class="files">
        {#each view.problemFiles as file, i (i)}
          <li data-status={file.status} class="bad"><span class="status">{t().fileStatus[file.status]}</span> <PackageText text={file.path} /></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if view.issues.length > 0}
    <section>
      <h3>{t().sections.issues}</h3>
      {#if language() !== "en"}<p class="note">{t().issueNote}</p>{/if}
      <ul class="issues">
        {#each view.issues as issue, i (i)}
          <li data-issue={issue.code}>
            <span class="axis">{t().axes[issue.axis].name}</span>
            {#if issue.subject !== undefined}<PackageText text={issue.subject} />:&nbsp;{/if}<PackageText text={issue.message} />
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if view.files.length > 0}
    <details>
      <summary>{t().sections.allFiles(view.files.length)}</summary>
      <ul class="files all">
        {#each view.files as file, i (i)}
          <li data-status={file.status} class={file.status === "valid" ? "good" : "bad"}>
            <span class="status">{t().fileStatus[file.status]}</span> <PackageText text={file.path} />
          </li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if view.signatures.length > 0}
    <details>
      <summary>{t().sections.signatures} ({view.signatures.length})</summary>
      {#each view.signatures as signature, i (i)}
        <dl class="record">
          <dt>{t().signature.entry}</dt>
          <dd><PackageText text={signature.entry} /></dd>
          {#if signature.signer !== undefined}
            {@const id = clip(signature.signer)}
            <dt>{t().signature.signer}</dt>
            <dd class="id"><PackageText text={id.text} />{#if id.length !== undefined}&nbsp;({id.length}){/if}</dd>
          {/if}
          {#if signature.role !== undefined}
            <dt>{t().signature.role}</dt>
            <dd><PackageText text={signature.role} /></dd>
          {/if}
          <dt>{t().signature.check}</dt>
          <dd>{t().verdicts.signature[signature.check]}</dd>
          {#if signature.trust !== undefined}
            <dt>{t().signature.trust}</dt>
            <dd>{t().verdicts.trust[signature.trust]}{#if signature.trustReason !== undefined}:&nbsp;<PackageText text={signature.trustReason} />{/if}</dd>
          {/if}
          {#if signature.claimedAt !== undefined}
            <dt>{t().signature.claimedAt}</dt>
            <dd><PackageText text={signature.claimedAt} /> <span class="note">({t().signature.claimedAtNote})</span></dd>
          {/if}
        </dl>
      {/each}
    </details>
  {/if}

  {#if view.anchors.length > 0}
    <details>
      <summary>{t().sections.anchors} ({view.anchors.length})</summary>
      {#each view.anchors as anchor, i (i)}
        <dl class="record">
          <dt>{t().signature.entry}</dt>
          <dd><PackageText text={anchor.entry} /></dd>
          <dt>{t().anchor.provider}</dt>
          <dd><PackageText text={anchor.provider} /></dd>
          <dt>{t().anchor.verdict}</dt>
          <dd>{t().verdicts.time[anchor.verdict]}{#if anchor.reason}:&nbsp;<PackageText text={anchor.reason} />{/if}</dd>
          {#if anchor.attestedAt !== undefined}
            <dt>{t().anchor.attestedAt}</dt>
            <dd>{formatTime(anchor.attestedAt, language())}</dd>
          {/if}
          {#if anchor.source !== undefined}
            <dt>{t().anchor.source}</dt>
            <dd><PackageText text={anchor.source} /></dd>
          {/if}
        </dl>
      {/each}
    </details>
  {/if}

  {#if technical.length > 0}
    <details>
      <summary>{t().sections.technical}</summary>
      <dl class="record">
        {#each technical as [key, value] (key)}
          <dt>{t().technical[key]}</dt>
          <dd class="id"><PackageText text={value} /></dd>
        {/each}
      </dl>
    </details>
  {/if}

  <p class="disclaimer">{t().disclaimer}</p>
</section>
