# Analiza rekordów i lekcji AEL

Stan odczytany 29 września 2026 r. Rejestr obejmuje pięć projektów. Baza zawiera jedną zweryfikowaną lekcję globalną, dotyczącą lokalizacji projektu `linkedin-posts`. Nie ma zapisanych lekcji repozytoryjnych ani automatycznych kandydatów. Sam brak kandydatów nie stanowi dowodu, że w sesjach nie wystąpiły sytuacje warte utrwalenia.[^data]

## Zakres i sposób sprawdzenia

Stan końcowy analizy: policzone rekordy dla wszystkich projektów z tabeli `repositories`, sprawdzone treści zapisanej wiedzy, pokrycie analizy i diagnostyka dostarczania. Sprawdzenie obejmuje zapytania SQL, kontrolę integralności oraz odczyt implementacji detektorów.

Główna baza została otwarta w trybie `mode=ro` i skopiowana przez SQLite backup do `/private/tmp/ael-analysis-2026-09-29.sqlite`. Najnowsze zdarzenie w tej kopii pochodzi z `2026-09-29T14:51:39.154Z`. Baza jest aktywna, dlatego kolejne odczyty mogą zwracać większe liczby. Analiza dotyczy zamrożonej kopii. Dwie bazy pomocnicze skopiowano osobno; ich liczniki nie tworzą jednej transakcji z główną bazą.[^data]

Globalny skill ma status `current`. Porównanie z `skills/ael` wykazało zgodność plików instrukcji; jedynym dodatkowym plikiem instalacji jest `.ael-skill.json`.

## Zarejestrowane projekty

| Projekt | Sesje | Sesje ze zdarzeniami | Zdarzenia | Sesje z dowolnym strumieniem analizy | Lekcje repozytoryjne |
|---|---:|---:|---:|---:|---:|
| agent-experience-agentic-sdd | 9 | 7 | 1680 | 9 | 0 |
| sisterhood | 12 | 9 | 2291 | 12 | 0 |
| wkregukobiet | 15 | 5 | 477 | 0 | 0 |
| SecondBrain | 37 | 30 | 635 | 6 | 0 |
| vimeo-downloader | 1 | 0 | 0 | 0 | 0 |
| Łącznie | 74 | 51 | 5083 | 27 | 0 |

Poza rejestrem występują dwie sesje: `codex-session`, przypisana do identyfikatora nieobecnego w `repositories`, oraz sesja z globalnym faktem o `linkedin-posts`. Pierwsza nie zawiera zdarzeń, druga zawiera jedno. Cała baza ma więc 76 sesji i 5084 zdarzenia. Projekty AEL i sisterhood odpowiadają za 3971 z 5083 zdarzeń zarejestrowanych projektów, czyli 78,1%.[^data]

Rejestr wskazuje Codex i Cursor jako wybrane źródła we wszystkich pięciu projektach. Wszystkie 5083 zdarzenia techniczne w głównej bazie pochodzą jednak z Codex. Cursor występuje w rekordach sesji i diagnostyce, lecz nie w tabeli `capture_events`.[^data]

## Co rzeczywiście zapisano jako wiedzę

Jedyny wpis ma identyfikator `knowledge-linkedin-posts-path-20260907`, stan `verified`, zakres `global`, zatwierdzenie `user` i aktywację `local`. Powstał 7 września 2026 r. o 09:03:24 UTC. Jego treść określa prywatną bezwzględną ścieżkę projektu `linkedin-posts`. Towarzyszą mu jedna obserwacja, jeden klaster, jeden kandydat typu `project-fact` i jeden dowód potwierdzający deklarację użytkownika.[^data]

To fakt lokalizacyjny. Nie opisuje sposobu rozwiązania błędu, korekty decyzji ani sprawdzonej procedury. Baza nie zawiera innych zapisanych lekcji. Liczby rekordów w `operational_episodes`, `operational_findings`, `operational_candidates` i `operational_insufficient_findings` wynoszą zero.[^data]

Tabela `operational_episode_evidence` zawiera 3069 rekordów: 1553 typu `tool-request` i 1516 typu `tool-result`. Wszystkie mają stan `observed`. Są to dowody techniczne, a nie 3069 lekcji ani epizodów. Nie występują tam instrukcje użytkownika, deklaracje agenta, przejścia zadania ani weryfikacje zadania.[^data]

## Dlaczego obecne dane nie wystarczają do oceny uczenia

W głównej bazie występuje 2580 zdarzeń `pre-action` i 2503 zdarzenia `post-result`. Każdy wynik jest powiązany z istniejącym żądaniem. Wszystkie 2503 wyniki mają `capture_outcome=unknown`, a żaden nie ma zapisanego `exit_status`. Różnica 77 między żądaniami i wynikami oznacza żądania bez odpowiadającego wyniku w tej kopii; nie dowodzi błędu wykonania.[^data]

Detektor napraw rozpoczyna od operacji z wynikiem `failed`. W tym zbiorze warunek nie jest spełniony ani razu. Adapter hooka Codex odczytuje kod wyjścia z pól `exit_status`, `exitStatus` lub `exit_code`; przy braku wartości nadaje `unknown`. Potwierdza to ograniczenie zapisanych danych, lecz nie ustala, na którym wcześniejszym etapie zniknęła informacja o wyniku.[^code]

Detektory weryfikacji i powtarzanej akceptacji wymagają odpowiednich typów dowodów, np. `task-transition`, `task-verification` lub `agent-claim`. W zapisanym zbiorze takich dowodów nie ma. Automatyczna analiza nie może na ich podstawie rozstrzygnąć, czy agent zamknął zadanie bez weryfikacji albo wielokrotnie zaakceptował tę samą decyzję.[^code]

## Pokrycie i wyniki przetwarzania

Zapisano 2758 zadań analizy: 2757 w stanie `completed` oraz jedno `quarantined-input`. Podział ukończonych zadań: AEL 1573, sisterhood 1092, SecondBrain 92. Liczba zadań nie jest liczbą unikalnych sesji ani zdarzeń.[^data]

W `wkregukobiet` wszystkie 477 zdarzeń należy do sesji bez strumienia analizy. W SecondBrain taki strumień mają sesje obejmujące 122 z 635 zdarzeń; pozostałe 513 nie ma strumienia. Łącznie 990 z 5083 zdarzeń zarejestrowanych projektów, czyli 19,5%, należy do sesji bez strumienia. Istnienie strumienia nie oznacza pełnego przetworzenia każdego zdarzenia.[^data]

W AEL jeden strumień `m9-typed-evidence@1` ma `committed_high_water=2` i `processed_high_water=1`. Dotyczy sesji `01a09ba8-2b36-7ad3-b2b9-3096ca1fc6cc`; jej zadanie znajduje się w kwarantannie wejścia od 13 września. Pole `failure_reason` jest puste, więc na podstawie tego rekordu nie da się przypisać przyczyny.[^data]

Tabela pokrycia ma 2010 wpisów: 1163 ukończone dla `m6-deterministic@1`, 845 ukończonych i dwa nieukończone dla `m9-typed-evidence@1`. Wszystkie raportują zero ustaleń. Suma `examined_events` dla starszego detektora wynosi 109089, mimo że cała baza ma 5084 zdarzenia. Nie jest więc miarą unikalnego materiału; obejmuje wielokrotne analizowanie zakresów.[^data]

## Kolejka i diagnostyka

Kopia kolejki zawiera 41 rekordów `pending`, w tym 36 z Codex i pięć z Cursor. Najstarszy oczekuje od 9 września 2026 r.; maksymalna liczba prób wynosi 1411. Liczniki zapisują 6516 przyjętych rekordów dostarczania, 5487 zatwierdzonych, 988 skierowanych do kwarantanny i zero błędów przyjęcia. Zachodzi równość `6516 = 5487 + 988 + 41`. Rekord dostarczania może dotyczyć zdarzenia technicznego albo cyklu sesji, więc nie należy utożsamiać tych liczników z liczbą zdarzeń w bazie.[^queue]

Wszystkie 988 rekordów kwarantanny mają kod `CORRUPT`: 965 dotyczy zdarzeń technicznych, 22 zakończeń sesji i jeden początku sesji. Kod jest klasyfikacją aplikacji, nie wynikiem kontroli integralności SQLite. `PRAGMA quick_check` zwróciło `ok` dla wszystkich trzech kopii baz.[^queue]

Przypisanie kwarantanny przez identyfikatory sesji z głównej kopii daje: AEL 525, sisterhood 366, SecondBrain 52, wkregukobiet 39 i sześć rekordów bez dopasowania. Z 41 oczekujących rekordów tylko jeden daje się przypisać tą metodą do AEL; 40 nie ma dopasowania. To granica użytej metody łączenia, nie dowód, że rekordy nie należą do żadnego projektu.[^queue]

Zachowane 10000 potwierdzeń odbioru obejmuje 7282 wpisy `delivery-retry`, 1692 `unsafe-normalization`, 942 `accepted`, 47 `unsupported-tool`, 35 `privacy-redaction` i dwa `quarantine`. Są to wpisy odbioru i ponowień, a nie 10000 unikalnych operacji. Dotyczą zachowanego okna od 15 do 29 września.[^queue]

Diagnostyka Cursor zawiera wyłącznie `invalid-working-directory`: 227 dla wkregukobiet, 1400 dla zakresu workspace `secondbrain` i 154 dla identyfikatora repozytorium spoza obecnego rejestru. Nie zapisuje dat pojedynczych błędów. Dane potwierdzają występowanie problemów z katalogiem roboczym; nie dowodzą, że każdy brakujący rekord Cursor wynika z tej przyczyny.[^queue]

## Obserwacje o sposobie pracy

Na poziomie żądań zapisano 919 operacji `edit` i 1330 operacji z akcją `rtk`. AEL ma m.in. 57 żądań `rtk pnpm build`, 41 `rtk pnpm test` oraz 25 `rtk pnpm check`. Sisterhood ma 34 żądania zaczynające się od `rtk pnpm test --`, 25 `rtk pnpm type-check` i 20 `rtk ./gradlew test --tests`. Wkregukobiet ma 22 żądania zaczynające się od `rtk /opt/homebrew/opt/ruby@3.2/bin/bundle exec jekyll`, 19 `rtk ruby scripts/test-pages-cms-content.rb --source-only` oraz 15 `rtk node scripts/test-mobile-ui.mjs`.[^data]

Są to obserwacje wywołań. Nie potwierdzają, że testy przeszły, że nastąpiła naprawa ani że zadanie spełniło kryteria akceptacji. Liczniki grupują początkowe tokeny podpisu polecenia, nie pełne polecenia.

## Kolejne sprawdzenia wynikające z danych

Najpierw należy prześledzić jeden rzeczywisty wynik polecenia od źródła do `capture_events` i ustalić, czy kod wyjścia dociera do adaptera. Kryterium sprawdzenia: kontrolowane powodzenie i błąd trafiają do bazy z rozróżnionym wynikiem, a brak informacji pozostaje `unknown`.

Osobnej diagnozy wymaga 41 oczekujących rekordów oraz kwarantanna `CORRUPT`. Kryterium: znana przyczyna na reprezentatywnych rekordach i potwierdzona zgodność liczników dostarczania, bez usuwania materiału dowodowego.

Pokrycie wkregukobiet i SecondBrain wymaga sprawdzenia rejestracji strumieni. Kryterium: każda sesja ze zdarzeniami ma jawny stan analizy, z uwzględnieniem kwarantanny i zakończonego zakresu. Cursor wymaga odrębnego sprawdzenia katalogu roboczego.

Do oceny jakości lekcji potrzebne są epizody z powiązanymi decyzjami, zmianą działania i weryfikacją zadania. Liczba wywołanych poleceń nie zastępuje takiego dowodu. To propozycje dalszych prac, a nie lekcje już zapisane lub zatwierdzone.

## Wykonane sprawdzenia

`rtk proxy node dist/src/cli.js skill status --scope global --json` zwróciło `current`. `rtk proxy diff -qr skills/ael /Users/michmzr/.agents/skills/ael` wskazało wyłącznie dodatkowy plik `.ael-skill.json` (kod 1 oznacza tę różnicę).

`rtk proxy node dist/src/cli.js --help` zakończyło się kodem 0. Zapytania odczytowe wykonano przez `rtk proxy python3` z `sqlite3`, na kopiach baz. `PRAGMA quick_check` zwróciło `ok` we wszystkich trzech bazach, a `PRAGMA foreign_key_check` w głównej bazie nie zwróciło naruszeń. Odczyt bezpośredni bazy kolejki zwrócił `unable to open database file`; odczyt jej lokalnej kopii zakończył się poprawnie.

Odczytano bieżące `src/learning/detectors.ts`, `src/learning/service.ts` i `src/capture/hook-adapters/codex.ts`. Nie uruchamiano ponownej analizy ani operacji zmieniających bazę. Zapytania akceptacyjne zapisano w pliku SQL obok raportu, a ich wynik w JSON.

[^data]: Odczyt wszystkich tabel głównej bazy `~/Library/Application Support/AgentExperience/experience.sqlite`, kopia `/private/tmp/ael-analysis-2026-09-29.sqlite`. Zapytania odczytowe i wynik: `2026-09-29-ael-audit.sql` oraz `2026-09-29-ael-audit-results.json` w tym samym katalogu.
[^code]: Bieżąca implementacja: `src/learning/detectors.ts` (funkcje `repairEpisodes` i `typedEpisodes`), `src/learning/service.ts` (`episodeEvidenceFromCapture`), `src/capture/hook-adapters/codex.ts` (`optionalExitStatus`, `outcome`).
[^queue]: Osobne kopie `capture-spool.sqlite` i `capture-diagnostics.sqlite` z tego samego katalogu danych, odczytane 29 września 2026 r.; kontrola integralności obu zwróciła `ok`.

Czy zero zapisanych lekcji operacyjnych mierzy brak przydatnych doświadczeń, czy przede wszystkim brak danych o wyniku i niepełne pokrycie analizy?
