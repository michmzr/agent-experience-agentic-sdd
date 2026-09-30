# Plan wykonania specyfikacji AEL

Status: implementacja lokalnej ścieżki i testy zintegrowane; kwalifikacja rzeczywistego hosta oraz pomiar AVB-B2 pozostają otwarte. Użytkownik zlecił 2026-09-30 wykonanie wszystkich ośmiu specyfikacji z indeksu AEL z podziałem na subagentów. Ten plan koordynuje istniejące plany kryteriów, nie zastępuje ich.

## Stan końcowy i weryfikacja

Każde kryterium ABI, AEC, ARC, ASC, ATI, ACL, AAP i AVB ma wykonany test wymagany w swoim planie, wynik publicznej ścieżki lub jawny status `unsupported` tam, gdzie kontrakt dopuszcza brak danych źródłowych. Po ostatniej zmianie kodu przechodzi `rtk pnpm check`; sprawdzone są migracja, restart, granice prywatności i rollback adekwatne do zmiany. Indeks dostaw wskazuje tylko fakty potwierdzone raportami. Kwalifikacja rzeczywistych hostów i rollout są osobnymi obserwowalnymi operacjami.

## Grupy i własność plików

| Grupa | Zależność | Worktree i właściciel | Wyłączna własność podczas pracy | Punkt kontrolny |
|---|---|---|---|---|
| AVB-B0 | stan `main` przed integracją ABI | `avb-baseline`, agent AVB | `src/benchmark/**`, testy i fixture AVB, `src/cli.ts` w tej gałęzi | Niezmienny baseline opisany jako stan `main` przed integracją, bez twierdzenia o historycznym pomiarze sprzed ABI |
| ABI-A5 / ARC-4 magazyn paragonów | rdzeń ABI | `arc-receipt-integration`, agent paragonów | `src/capture/spool.ts`, `src/capture/hook-ingress.ts`, `src/capture/receipts.ts`, testy ABI-A5 i paragonów | Atrybucja buildu przechwycenia i writera retry w osobnych rolach; stare paragony `unknown`; retencja i migracja |
| AEC | rdzeń ABI | `aec-continuity`, agent AEC | adapter Codex, `src/evidence/**`, `src/storage/experience-store.ts`, `src/learning/service.ts`, `src/learning/repository.ts`, `src/application/experience-service.ts`, testy AEC | AEC-A1–A6; źródłowe koperty tylko po kwalifikacji, bez wymyślania danych hosta |
| ARC pozostałe | AEC i magazyn paragonów | `arc-receipt-integration` dla ARC-A1; kolejny worktree po integracji dla współdzielonych plików | agent ARC: spool i drain; integrator: `src/cli.ts`, `src/application/experience-service.ts`, rekoncyliacja i health v3 | ARC-A1–A6 oraz pełne ABI-A5 |
| ASC | AEC | `asc-scoped-conventions` dla ASC-A1/A2 | agent ASC: parser, ustawienia i kontrakty; współdzielone pliki learning dopiero po zwolnieniu ich przez AEC/ARC | ASC-A1–A5 |
| ATI | AEC i ARC | osobny worktree po ARC | producent typowanych danych; `src/cli.ts` tylko po ARC | ATI-A1–A6 |
| ACL | ASC i ATI | osobny worktree po ATI | kandydaci, przegląd, retrieval; `src/cli.ts` tylko po ATI | ACL-A1–A7 |
| AVB-B1 | ABI, AEC, ARC, ASC, ATI i ACL | gałąź benchmarku po integracji | `src/benchmark/**` i fixture AVB | Publiczny pipeline i bramki bezpieczeństwa AVB-A2–A3 |
| AAP i AVB-B2 | AVB-B1; decyzja ADR 002 przed AAP | kolejne osobne worktrees | doradztwo, następnie benchmark porównawczy | AAP-A1–A5 i AVB-A4–A6 |

Główny checkout zawiera niezatwierdzone pliki dokumentacji użytkownika. Nikt nie edytuje ich w miejscu. Specyfikacje i plany są przenoszone selektywnie do właściwych worktrees; nowszych dokumentów ABI nie wolno nadpisać wersją z `main`.

## Kolejność integracji

1. AVB-B0 z `main`, magazyn paragonów ABI-A5 i pierwszą część AEC zintegrowano kolejno w gałęzi ABI. Po migracji 18 pełna kontrola zakończyła się wynikiem 929/929. Otwarta pozostała kwalifikacja rzeczywistego hosta AVB i AEC.
2. Domknąć błędy znalezione w przeglądzie AEC: niepełny backfill bez restartu, konflikt identyfikatorów między starymi tabelami i kolejność zdarzeń na granicy strony. Dokończyć AEC-A4–A6 i stabilną tożsamość operacji ABI-A5 po zmianie buildu; każdą zmianę ponownie zweryfikować.
3. Zintegrować ARC-A1 oraz ASC-A1/A2 z osobnych worktrees, potem dokończyć ARC i ASC. Zmiany `src/learning/**` i `src/cli.ts` integrować kolejno.
4. Po zamknięciu ARC i ASC wykonać ATI, ACL, AVB-B1, AAP i AVB-B2 zgodnie z zależnościami. Nie ogłaszać korzyści netto bez porównania i telemetrii przewidzianych w AVB.

## Zapis wykonania z 2026-09-30

ABI, AEC, ARC, ASC, ATI, ACL i lokalne ścieżki AAP/AVB-B1 zintegrowano w `codex/abi-build-identity`. Publiczny przepływ AAP sesja A→B przeszedł dla konwencji i nowego faktu projektu; dostarczenie pozostaje `agent-claim`. AVB-B2 ma protokół pięciu par i status `incomplete`, bez rzeczywistych prób hosta i bez pomiaru oszczędności. Wyniki komend i ograniczenia kwalifikacji są w [nocie weryfikacyjnej](../docs/verification/2026-09-30-ael-eight-spec-integration.md), a przypisanie 46 wymagań do dowodów w [manifeście](../docs/verification/2026-09-30-ael-requirement-traceability.json).

Wynik AVB-B0 z obecnego `main` nie będzie nazywany historycznym pomiarem sprzed implementacji ABI. Zachowany syntetyczny baseline ABI jest odrębnym artefaktem.
