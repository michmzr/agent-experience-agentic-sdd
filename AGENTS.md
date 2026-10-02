# AEL local installation

Before using an installed local copy of the `ael` skill, update that copy from this repository so the installed version matches the newest repository version. Do not operate an outdated local AEL installation when a newer version is available in the project.

## Aktualizacja systemowej instalacji po merge

Po każdym merge do `main` zbuduj i udostępnij w systemie aktualną wersję AEL z wynikowego commita. Aktualizacja instalacji jest częścią zakończenia merge, także gdy zmiana dotyczy wyłącznie dokumentacji.

- Uruchom `rtk pnpm build` w kanonicznym lokalnym checkout `main`. Sprawdź, że `build-manifest.json` zawiera `sourceRevision` równą aktualnemu `HEAD`, a artefakty przechodzą walidację manifestu. Hash `buildId` może pozostać taki sam, jeśli pliki dostarczanego toola nie zmieniły się.
- Zaktualizuj globalne polecenie `ael` przez `rtk proxy pnpm add -g link:/Users/michmzr/projects/agent-experience-agentic-sdd` oraz globalny skill przez `rtk proxy node dist/src/cli.js skill update --scope global --yes --json`.
- Odczytaj wszystkie rejestracje przez `status-global --json` i sprawdź każdą przez `installation inspect --repository-id <id> --json`. Każdy managed wrapper ma wskazywać aktualny lokalny build; hooki muszą zachować wybrane źródła oraz niezwiązane ustawienia. Nieaktualne instalacje Git wyrównuj przez `installation plan/apply`; workspace bez Git obsługuj przez istniejący `init --scope workspace` z zachowaniem jego identyfikatora i źródeł.
- Zweryfikuj globalne `ael`, status `current` skilla oraz identyfikator buildu każdej instalacji. Podaj wynik aktualizacji w odpowiedzi końcowej. Jeśli build lub aktualizacja instalacji nie przejdzie, zgłoś konkretny błąd i nie oznaczaj zadania jako zakończonego.

## Definition of done

- Przed zmianą określ obserwowalny stan końcowy i sposób jego sprawdzenia.
- Przy diagnozowaniu najpierw odtwórz problem i sprawdź hipotezę.
- Nie edytuj kodu przed odczytaniem bieżącej implementacji.
- Po ostatniej zmianie uruchom całą uzgodnioną ścieżkę akceptacji.
- Podaj wykonane komendy i ich wyniki.
- Dostosuj zakres kontroli do skutków możliwego błędu.
- Równoległe zmiany wykonuj w oddzielnych worktrees z jawną własnością plików.
- Powtarzającą się korektę zamień w regułę, test, skrypt lub skill.
