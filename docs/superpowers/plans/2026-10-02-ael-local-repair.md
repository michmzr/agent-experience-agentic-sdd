# Plan naprawy lokalnego AEL

> Dla wykonawcy: realizuj etapy operacyjne po kolei, korzystając z `superpowers:executing-plans`. Użycie subagentów wymaga osobnej autoryzacji. Zmiany kodu wykonuj w izolowanym worktree. Etapy zmieniające publiczny kontrakt CLI lub stan kwarantanny wymagają zatwierdzenia powiązanej specyfikacji przed opracowaniem szczegółowego planu implementacji.

Cel: potwierdzić dopływ kompletnych nowych sesji przez rzeczywiste hosty, odzyskać wyłącznie dane z wystarczającym pochodzeniem oraz przywrócić analizę poprawnych zakresów bez usuwania historii błędów.

Architektura: zachować istniejący lokalny build, pasywne hooki i SQLite. Użyć istniejących mechanizmów ARC do podglądu, odzyskiwania i uzgadniania; brakujące mechanizmy naprawy opisać osobno, bez ręcznego przestawiania stanów SQL. Runtime egzekwujący reguły i pilot podpowiedzi mają osobne kryteria aktywacji.

Technologie: TypeScript, Node.js z `node:sqlite`, `node:test`, pnpm. Plan nie wymaga nowej zależności produkcyjnej.

## Status i podstawy

Plan przygotowany 2026-10-02 na prośbę użytkownika. W tym etapie nie wykonano operacji naprawczych na produkcyjnej bazie. Obowiązują zatwierdzone kontrakty ARC, AEC, ABI, ASC oraz AAP. Uzupełnienia publicznego CLI i ponownego uruchamiania kwarantanny pozostają projektem specyfikacji zgodnie z `.agents/SDD.md`.[^contracts]

Stan końcowy jest obserwowalny: nowa sesja `startup` i wznowiona sesja `resume` mają poprawną tożsamość, operacje oraz zakończenie; poprawne nowe dane nie pozostają w `waiting-dependency`; aktualny zakres analizy osiąga właściwy stan dla każdego detektora. Nierozwiązywalne stare dane zachowują pochodzenie i jawny powód. Licznik kwarantanny nie musi spaść do zera, a puste wyniki nie są dowodem skuteczności.

## Sprawdzone dane wejściowe

Poniższe wartości są wynikami odczytów 2026-10-02, a nie zamrożonymi licznikami. Podczas audytu nadal napływały zdarzenia.

| Obszar | Wynik audytu | Znaczenie dla naprawy |
|---|---|---|
| Instalacja | 5 wrapperów wskazuje lokalny `dist/src/cli.js`; build `13ea2a282975bc683111c438dc8cf23658e7b298f2036d68b4d17448ff8b6947`, rewizja `a02b700` | Nie reinstalować poprawnych integracji jako sposobu naprawy danych |
| Test wrapperów | Codex i Cursor: 10/10 ścieżek dostarczyło kompletne syntetyczne sesje | Potwierdzono wykonanie wrapperów, nie automatyczne wywołanie przez desktop ani obsługę `resume` |
| Ustawienia projektu | Wszystkie ustawienia przechodzą walidację; deadline dostawy 2000 ms; wrappery mają tryb 755 | Nie zwiększać deadline w celu ukrycia zaległości |
| Dopływ | 4562 wpisy `missing-session`: 4560 technicznych i 2 zakończenia, wszystkie Codex, od 2026-10-01 | Priorytetem jest rzeczywiste źródło `SessionStart`, korelacja sesji i wznowienie |
| Transport | W poprzednim odczycie 4586 pending, historyczne attempts do 2052 | Rozróżnić stare liczniki od prób w bieżącej generacji ARC |
| Kwarantanna transportu | 988 `CORRUPT`, daty 2026-09-08 do 2026-09-26 | Nie uznawać historycznego zbioru za regresję aktualnego buildu |
| Zadania analizy | 4 `quarantined-input`: 2 `execution-failure`, 1 `invalid-input`, 1 bez przyczyny; 1 pending | Osobno odtworzyć błędne wejście i błąd wykonania; sam restart nie naprawia kwarantanny |
| Podgląd reconcile | AEL: 7 missing/10 sesji; sisterhood: 9/12; SecondBrain: 30/40 i 1 unavailable | Istnieje praca możliwa do ponownego przyjęcia bez zmiany danych źródłowych |
| Podgląd wkregukobiet | Jeden odczyt zwrócił `STORAGE_ERROR: database is locked` | Powtórzyć odczyt na spójnej kopii i rozróżnić konflikt dostępu od błędu danych |
| Regresja benchmarku | Pierwszy `rtk pnpm check` podczas przygotowania merge: 1124/1125, AVB-A2/B1 przerwany przez `candidates review: database is locked`; osobny test: 1/1 | Zachować oba wyniki i odtworzyć konkurencję; pojedynczy udany przebieg nie oznacza naprawy przyczyny |
| Podgląd recovery | Pierwsze strony nie wybierają rekordów; część historii ma `missing-recovery-metadata`; dostępne kolejne strony | Pierwsza strona nie dowodzi braku odzyskiwalnych danych w całym zbiorze |
| Runtime | `degraded`, brak `active-target.json` i poprawnego snapshotu | Nie generować pustego snapshotu tylko po to, aby otrzymać `healthy` |
| Podpowiedzi | `enabled=false` dla 5 rejestracji | To zgodny ze specyfikacją domyślny stan AAP, nie usterka |

Źródła audytu: CLI `installation inspect`, `status-global --schema-version 3`, `capture status`, `analysis status`, `runtime status`, podglądy `analysis reconcile` i recovery oraz zagregowane odczyty SQLite bez treści komend.[^audit]

## Kolejność i odpowiedzialność

| Etap | Priorytet | Rezultat wymagany przed kolejnym etapem |
|---|---|---|
| 1. Spójna kopia i punkt odniesienia | P0 | Poprawne backupy, identyfikatory artefaktów, zamknięty zbiór danych do diagnozy |
| 2. Dopływ nowych sesji | P0 | Test prawdziwego hosta dla startup i resume; przyczyna braków potwierdzona lub jawnie unsupported |
| 3. Historyczne zależności | P0 | Każdy badany przypadek ma potwierdzone pochodzenie albo jawny brak dowodu; odzyskanie tylko kwalifikowanych rekordów |
| 4. Analiza i kwarantanna zadań | P0 | Przyjęcie brakującej pracy, reprodukcje błędów, ukończenie kwalifikowanych zakresów |
| 5. Jedna ścieżka weryfikacji instalacji | P1 | CLI sprawdza faktyczny wspólny build i rozróżnia test wrappera od hosta |
| 6. Runtime i podpowiedzi | P1, osobna bramka | Aktywacja tylko po kwalifikacji wiedzy i danego kanału |
| 7. Wdrożenie i dowody | P0 dla każdej naprawy | Testy regresji, kontrolowany canary, ponowny audyt pięciu rejestracji |

Zespoły równoległe, jeśli użytkownik je autoryzuje, otrzymują oddzielne worktrees. Właściciel capture odpowiada za `src/capture/`; właściciel learning za `src/learning/`; właściciel instalacji za `src/cli/hook-readiness.ts` i `src/installation/`. Zmiany `src/cli.ts`, migracji wspólnej bazy i wdrożenie produkcyjne są wykonywane kolejno przez integratora.

## Etap 1: Spójny punkt odniesienia

- [ ] Zakończyć aktywne sesje hostów i sprawdzić, że nie ma aktywnego drain, koordynatora ani workerów. Nie usuwać lease ani nie zabijać procesu w celu wymuszenia tego stanu.
- [ ] Odczytać `capture status`, `analysis status`, `status-global --schema-version 3`, status skilla i manifest buildu. Zapisać wyniki w prywatnym katalogu audytu, poza Git.
- [ ] W stanie bez dopływu użyć online backup SQLite dla obu baz. Osobne backupy nie tworzą atomowego snapshotu dwóch baz przy aktywnych writerach; warunek zatrzymanego dopływu jest obowiązkowy.

Polecenia bazowe:

```sh
rtk proxy ael capture status --json
rtk proxy ael analysis status --json
rtk proxy ael status-global --schema-version 3 --json
rtk proxy ael skill status --scope global --json
rtk proxy node -e 'console.log(JSON.stringify(require("./build-manifest.json")))'
```

Do wykonania backupu użyć poniższego skryptu zapisanego podczas realizacji jako `/private/tmp/ael-repair-backup.mjs`. Pierwszy argument to katalog danych, drugi to nowy prywatny katalog docelowy:

```js
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || !isAbsolute(source) || !isAbsolute(destination)
    || existsSync(destination)) throw new Error('New absolute backup destination required.');
mkdirSync(destination, { mode: 0o700 });
for (const name of ['experience.sqlite', 'capture-spool.sqlite']) {
  const input = new DatabaseSync(join(source, name), { readOnly: true });
  try { await backup(input, join(destination, name)); }
  finally { input.close(); }
  chmodSync(join(destination, name), 0o600);
  const copy = new DatabaseSync(join(destination, name), { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    const foreignKeys = copy.prepare('PRAGMA foreign_key_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok'
        || foreignKeys.length !== 0) throw new Error('Backup validation failed: ' + name);
  } finally { copy.close(); }
}
for (const name of ['runtime', 'repository-knowledge']) {
  if (existsSync(join(source, name))) cpSync(join(source, name), join(destination, name), { recursive: true });
}
console.log('backup-valid');
```

```sh
rtk proxy node /private/tmp/ael-repair-backup.mjs '/Users/michmzr/Library/Application Support/AgentExperience' /private/tmp/ael-repair-baseline-2026-10-02
```

- [ ] Zapisać odrębnie kopie AEL-owned wrapperów i konfiguracji hooków pięciu rejestracji, z sumami SHA-256. Pełne dane pozostają lokalne i prywatne.
- [ ] Utworzyć drugą kopię roboczą od poprawnego backupu. Wszystkie mutujące reprodukcje historyczne kierować przez `--data-dir` do tej kopii.

```sh
rtk proxy node -e 'const fs=require("node:fs");const target="/private/tmp/ael-repair-working-2026-10-02";if(fs.existsSync(target))throw new Error("Working copy already exists");fs.cpSync("/private/tmp/ael-repair-baseline-2026-10-02",target,{recursive:true});fs.chmodSync(target,0o700);'
```

Akceptacja: obie bazy mają `integrity_check=ok`, brak naruszeń foreign keys, a snapshot nie miesza stanu z różnych momentów aktywnego dopływu. Błąd backupu blokuje mutacje, nie odczytową diagnozę.

## Etap 2: Odtworzenie brakującego początku sesji

Pliki do odczytu: `src/capture/hook-adapters/codex.ts`, `src/capture/hook-ingress.ts`, `src/capture/spool-drain.ts`, `src/capture/passive-service.ts`, `src/cli/hook-installation.ts`, `test/session-lifecycle.test.ts`, `test/capture-spool.test.ts`.

- [ ] Zamrozić ograniczoną próbkę nowych rekordów `missing-session` z 2026-10-01 i 2026-10-02 na kopii. Grupować po źródle, wewnętrznym identyfikatorze sesji, rodzaju i czasie; nie umieszczać treści narzędzi ani surowych identyfikatorów w publicznych artefaktach.
- [ ] Porównać tożsamości w records, sessions, lifecycle i evidence. Oddzielić brak dostawy `SessionStart` od odrzucenia payloadu i od błędnej korelacji. Każda hipoteza ma pojedynczy kontrprzykład.
- [ ] W rzeczywistym Codex desktop rozpocząć nową rozmowę w canary projektu AEL, wykonać nieszkodliwy odczyt, zakończyć i wznowić tę rozmowę. Zweryfikować zaufanie hooka, matcher, dokładny zaakceptowany typ źródła oraz lifecycle. Syntetyczne stdin i `codex exec` nie zastępują kwalifikacji desktop.
- [ ] Powtórzyć rzeczywisty lifecycle w `SecondBrain`, który jest workspace bez Git. Nie zastępować go sztucznym `git init`.
- [ ] Jeśli dostęp do rzeczywistego hosta jest niedostępny, zapisać `unsupported` wraz z brakującym dowodem; nie oznaczać etapu jako zaliczony.
- [ ] Utworzyć zanonimizowany fixture potwierdzonego błędu i test publicznej ścieżki intake/drain. Najpierw pokazać semantyczny RED, potem minimalną poprawkę zgodną z AEC/ARC i GREEN. Inny kontrakt payloadu wymaga aktualizacji specyfikacji, nie zgadywania pola `source`.

Akceptacja: startup i resume są obserwowane przez wybrany rzeczywisty host, nie powstaje nieudokumentowana sesja, a nowe poprawne operacje docierają w skonfigurowanym deadline po dostępności ich zależności. Nowy problem nie zostaje ukryty przez ponowne instalowanie wrapperów lub zwiększenie timeoutu.

## Etap 3: Odzyskanie kwalifikowanej historii

- [ ] Zakończyć wszystkie strony podglądu recovery dla każdej rejestracji. `--limit` ogranicza wybrane rekordy, a `nextCursor` wymaga kolejnej strony; początkowa pusta strona nie oznacza pustego zbioru.
- [ ] Dla osieroconych rekordów szukać istniejącego, autentycznego zdarzenia początku sesji oraz identycznej tożsamości i scope. Nie tworzyć `SessionStart` z daty pierwszej operacji ani nie przypisywać repozytorium z bieżącego cwd operatora.
- [ ] Rekordy bez dowodu pozostawić jako oczekujące/nierozwiązywalne według zatwierdzonego kontraktu, z powodem i licznością. Nie usuwać 988 starych `CORRUPT` ani nie generować dla nich metadanych kwalifikacji bez dowodu.
- [ ] Na kopii zastosować wyłącznie hash-bound plan dla maksymalnie 10 kwalifikowanych rekordów. Wykonać drain. Zastosować ten sam plan ponownie i wykazać brak duplikatów.

Przykład dla projektu AEL na kopii:

```sh
rtk proxy ael capture recovery plan --repository-id 220ce154c82b7b38a2c38078ca640f0e4a9df4a3462f7ac9acb24ba785040ed1 --limit 10 --output /private/tmp/ael-repair-capture-page.json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael capture recovery apply --input /private/tmp/ael-repair-capture-page.json --json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael capture drain --json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael capture recovery apply --input /private/tmp/ael-repair-capture-page.json --json --data-dir /private/tmp/ael-repair-working-2026-10-02
```

- [ ] Następną stronę tworzyć z `--cursor` równym dokładnemu `nextCursor` z poprzedniego planu. Plany produkcyjne tworzyć ponownie na produkcji po kwalifikacji kopii, ponieważ zmiana danych lub buildu unieważnia wcześniejszy plan.
- [ ] Jeśli potrzebna jest migracja legacy metadata albo odzyskanie potwierdzonego source-start bez obsługiwanej ścieżki CLI, przygotować fixture i uzupełnienie specyfikacji. Nie stosować ręcznych UPDATE/INSERT jako obejścia.

Akceptacja: każda zastosowana selekcja ma poprawny hash, scope i pochodzenie; powtórzenie nie dodaje nowych faktów; zachowane są oryginalne klasyfikacje i historia. Attempts w nowej generacji mają limit ARC. Liczniki historyczne mogą pozostać większe.

## Etap 4: Przywrócenie analizy

Pliki: `src/learning/reconciliation.ts`, `src/learning/repository.ts`, `src/learning/service.ts`, `src/learning/worker.ts`, `src/learning/worker-launcher.ts`. Testy: `test/ael-recovery-reconcile.test.ts`, `test/analysis-worker.test.ts`, `test/automatic-analysis-acceptance.test.ts`.

- [ ] Na kopii odtworzyć cztery zadania z kwarantanny osobno. Dla `invalid-input` wskazać naruszony invariant; dla `execution-failure` sprawdzić proces potomny, worker slot, wersję parsowania, rekord i ograniczenia czasu; stary brak reason pozostaje jawnie nieznany.
- [ ] Dla potwierdzonego błędu kodu dodać fixture, uruchomić RED, poprawić najmniejszą odpowiedzialną jednostkę i uruchomić GREEN. Nie zwiększać limitu prób w celu zamaskowania błędu.
- [ ] Odtworzyć także blokadę z `test/ael-value-benchmark-runner.test.ts` podczas `candidates review`. Porównać pełny zestaw z testem pojedynczym, sprawdzić transakcje i procesy analizy pracujące na bazie fixture. Nie utożsamiać tego przypadku z blokadą produkcyjną bez wspólnego dowodu przyczyny.
- [ ] Uruchomić wszystkie strony reconcile bez `--apply`, zapisać `missing`, `unavailable`, `optedOut` i kursory. Wkregukobiet sprawdzić na kopii: jeśli odczyt przechodzi, osobno odtworzyć konkurencję powodującą `database is locked`.
- [ ] Zastosować reconcile wyłącznie dla `missing` na kopii, uruchomić istniejący worker i kontrolować status. Zakończenie workera po idle timeout jest poprawne; plan nie wprowadza stałego daemona.

```sh
rtk proxy ael analysis reconcile --repository-id 220ce154c82b7b38a2c38078ca640f0e4a9df4a3462f7ac9acb24ba785040ed1 --json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael analysis reconcile --repository-id 220ce154c82b7b38a2c38078ca640f0e4a9df4a3462f7ac9acb24ba785040ed1 --apply --json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael analysis worker --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael analysis status --json --data-dir /private/tmp/ael-repair-working-2026-10-02
rtk proxy ael analysis report --repository-id 220ce154c82b7b38a2c38078ca640f0e4a9df4a3462f7ac9acb24ba785040ed1 --schema-version 3 --json --data-dir /private/tmp/ael-repair-working-2026-10-02
```

- [ ] Dalsze strony reconcile obsłużyć przez `--after-session` z dokładnym `nextCursor`. Powtórzyć dla pozostałych czterech rejestracji, zachowując ich własne identyfikatory z inventory.
- [ ] Powtórny reconcile dla tego samego, niezmienionego zakresu ma `added=0`.
- [ ] Kwarantanny nie resetować SQL. Gdy poprawna praca nadal jest zablokowana i nie istnieje publiczna droga wznowienia, wdrożenie tego fragmentu wymaga zatwierdzenia projektu specyfikacji naprawczej. Nie zmieniać wersji detektora wyłącznie w celu ominięcia kwarantanny.

Akceptacja: poprawne zakresy są ukończone i mają jawny wynik poszczególnych detektorów. `insufficient-evidence` jest poprawnym wynikiem dla niewystarczających danych; nie jest zamieniany na `evaluated-no-findings`. Błędne dane pozostają odrębne od awarii wykonania.

## Etap 5: Poprawa narzędzia weryfikacji

Znany reprodukowalny problem: `hooks verify --worktree` wymaga `<root>/dist/src/cli.js`, choć wrapper wskazuje poprawny wspólny build. Odrzuca również workspace bez Git. Istniejący `installation inspect --repository-id` odczytuje taki workspace poprawnie.

Własność: `src/cli/hook-readiness.ts`, `test/hook-readiness.test.ts`, `src/installation/inspection.ts`, dokumentacja setup. Publiczne rozszerzenie opisano w projekcie specyfikacji; implementacja zaczyna się po jego zatwierdzeniu.

Poniższy test odtwarza znany problem wspólnego buildu w izolacji; `installHooks` zaimportować z istniejącego modułu i `execFileSync` z `node:child_process`:

```ts
test('verifies managed hooks targeting a shared local build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ael-shared-build-'));
  const scratch = mkdtempSync(join(tmpdir(), 'ael-shared-check-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    installHooks({ repositoryRoot: root, sources: ['codex', 'cursor'],
      cliEntrypoint: join(process.cwd(), 'dist/src/cli.js') });
    assert.equal(existsSync(join(root, 'dist/src/cli.js')), false);
    const result = await verifyHookReadiness({ worktreePath: root, temporaryRoot: scratch });
    assert.equal(result.status, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
```

- [ ] Po zatwierdzeniu specyfikacji uruchomić test i zapisać RED z `BUILD_MISSING`.
- [ ] Użyć rozpoznanego managed wrappera i zweryfikowanego manifestu jako źródła celu; nie parsować i nie wykonywać dowolnego polecenia z konfiguracji.
- [ ] Dodać odrębny przypadek registered workspace bez Git, startup/resume i negatywne przypadki zmodyfikowanego wrappera, artefaktu, niespójnego scope i niedostępnego celu.
- [ ] Dokumentować oddzielnie test wykonania wrappera i kwalifikację rzeczywistego hosta. `installation inspect` pozostaje operacją bez wykonywania wrappera.

Akceptacja: wspólny build i SecondBrain można sprawdzić publiczną ścieżką, a nie prywatnym skryptem smoke; polecenie nie sugeruje kwalifikacji hosta wyłącznie na podstawie syntetycznej dostawy.

## Etap 6: Kwalifikacja wiedzy i aktywacji

- [ ] Traktować brak snapshotu jako jawny brak aktywowanej wiedzy. Runtime enforcement nie jest dowodem, że pasywne hooki blokują operacje.
- [ ] Zweryfikować istniejące wpisy przez lifecycle, scope, freshness i konflikty. Nie promować obserwacji automatycznie do `verified`.
- [ ] Jeśli istnieje rzeczywiście zweryfikowana wiedza repozytorium, sprawdzić zaufany ref i dopiero wtedy użyć `knowledge refresh-runtime`. Jeśli takiej wiedzy nie ma, pozostawić jawny stan unavailable/degraded bez tworzenia sztucznej reguły.
- [ ] Pilot advice rozpocząć tylko w jednym repozytorium projektu AEL. Warunkiem jest kwalifikacja aktualnego kanału AAP i dostępność eligible verified entry; włączenie flagi samo w sobie nie dostarcza podpowiedzi.
- [ ] Po spełnieniu warunków użyć `advice configure`, sprawdzić retrieval, osobno delivery, application i outcome oraz zweryfikować revocation. Brak pełnego dowodu AAP-A4 pozostaje otwarty; nie włączać pozostałych czterech rejestracji na podstawie samego lookup.

Polecenia kwalifikacji istniejącego kontraktu:

```sh
rtk proxy ael knowledge validate --repository /Users/michmzr/projects/agent-experience-agentic-sdd --trusted-ref main --json
rtk proxy ael advice status --repository-id 220ce154c82b7b38a2c38078ca640f0e4a9df4a3462f7ac9acb24ba785040ed1 --json
```

`main` można użyć wyłącznie po potwierdzeniu, że jest właściwym zaufanym ref dla zweryfikowanego zbioru; aktualna nazwa gałęzi nie ustanawia autorytetu.

Akceptacja: brak fałszywego `healthy`, brak nowej władzy nad operacjami wynikającej z odzyskania danych, pilot pozostaje default-off poza jawnie zakwalifikowanym zakresem.

## Etap 7: Wdrożenie i utrwalenie dowodów

- [ ] Po ostatniej zmianie kodu uruchomić pełną ścieżkę akceptacji oraz rzeczywiście zmienione focused suites. Zachować wynik reprodukcji RED i końcowe wyniki GREEN.

```sh
rtk pnpm build
rtk proxy node --test dist/test/session-lifecycle.test.js dist/test/capture-spool.test.js dist/test/ael-recovery-coverage.test.js dist/test/ael-recovery-plans.test.js dist/test/ael-recovery-plans-public.test.js dist/test/ael-recovery-reconcile.test.js dist/test/analysis-worker.test.js dist/test/automatic-analysis-acceptance.test.js dist/test/hook-readiness.test.js
rtk pnpm check
rtk git diff --check
```

- [ ] Canary: jedno repozytorium i jedna świeża sesja rzeczywistego hosta. Dopiero po pozytywnym wyniku wygenerować aktualne plany produkcyjne i obsługiwać kolejne repozytoria pojedynczo.
- [ ] Wykonać ograniczoną partię mutacji, sprawdzić liczniki, identity, foreign keys, unikalność operacji, stare klasyfikacje i brak nowych wrażliwych pól. Przerwać przy nowym konflikcie scope albo nieoczekiwanej kwarantannie.
- [ ] Sprawdzić każde z pięciu repozytoriów po buildzie: faktyczny target, artifact digest, kontrakt hooków i dostępność. Polecenie globalne `ael` oraz wszystkie wrappery muszą pozostać zgodne.
- [ ] Wykonać ponowny odczyt statusu po kontrolowanej serii nowych sesji. Oceniać nowe zakresy i ich zależności, nie spadek wszystkich liczników historycznych.
- [ ] Zapisać `docs/verification/2026-10-02-ael-local-repair.md` z dokładnymi komendami, wynikami, build identity, acceptance IDs, kwalifikacją hostów, zakresami odzyskania i pozostałymi brakami. Do Git trafiają tylko zanonimizowane fixtures i zagregowane dane.

Rollback: przywracać tylko zapisane AEL-owned konfiguracje i artefakt zgodny z writer floor. Nie nadpisywać działającej bazy backupem, jeśli po baseline pojawiły się nowe fakty. Przywrócenie całej bazy wymaga zatrzymanego dopływu oraz dowodu, że nie utraci późniejszych zapisów; w przeciwnym razie stosować korektę do przodu zachowującą historię.

## Kontrola zakresu planu

Operacyjne etapy 1–4 wykorzystują istniejące zaakceptowane kontrakty, ale naprawa konkretnego błędu kodu zaczyna się dopiero po reprodukcji. Nowe zachowanie CLI weryfikacji i bezpieczne wznowienie kwarantanny opisuje osobny projekt specyfikacji. Etap 6 ma własne warunki kwalifikacji; nie jest automatyczną zmianą wszystkich flag konfiguracyjnych.

[^contracts]: `docs/superpowers/specs/2026-09-29-ael-recovery-coverage-design.md`, `docs/superpowers/specs/2026-09-29-ael-evidence-continuity-design.md`, `docs/superpowers/specs/2026-09-29-ael-build-identity-design.md`, `docs/superpowers/specs/2026-09-29-ael-advisory-pilot-design.md`, `.agents/SDD.md`, `.agents/QUALITY-GATES.md`.
[^audit]: Audyt lokalny 2026-10-02: odczytowe agregacje `records`, `capture_recovery_state`, `quarantined_records`, `operational_analysis_jobs`; publiczne podglądy recovery/reconcile oraz test wrapperów w odrębnych tymczasowych bazach. Pliki diagnostyczne `/private/tmp/ael-config-audit.mjs` i `/private/tmp/ael-plan-evidence.mjs` są pomocnicze; wykonanie planu wymaga nowego snapshotu, nie ich utrzymania.
