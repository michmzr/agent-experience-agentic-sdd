# Walidacja zainstalowanego skilla AEL

## Problem

Polecenie `ael skill validate <skill-directory>` zwraca `invalid` dla poprawnej instalacji utworzonej przez `ael skill install`. Instalacja zawiera zarządzany manifest `.ael-skill.json`, natomiast publiczne polecenie używa walidatora źródła, który dopuszcza wyłącznie pliki artefaktu i odrzuca manifest jako plik dodatkowy.

`ael skill status` zwraca dla tego samego katalogu `current`, ponieważ korzysta z osobnego walidatora instalacji. Dwa publiczne polecenia dają więc sprzeczne wyniki dla niezmienionego katalogu.

## Zachowanie docelowe

Publiczna walidacja rozpoznaje rodzaj katalogu na podstawie obecności `.ael-skill.json`:

- katalog bez manifestu jest sprawdzany jako źródło skilla;
- katalog z manifestem jest sprawdzany jako instalacja zarządzana.

Walidacja instalacji zachowuje istniejące kontrole: kanoniczny manifest, zgodność hashy, dokładną listę plików, limity rozmiaru, zwykłe pliki oraz brak dowiązań symbolicznych. Nieprawidłowy lub dodatkowy plik nadal powoduje wynik `invalid`.

## Granice zmiany

Zmiana dotyczy publicznej ścieżki `skill validate`. Walidacja źródła używana podczas instalacji i aktualizacji pozostaje odrębna, aby katalog źródłowy nie mógł zostać zaakceptowany na podstawie własnego manifestu instalacyjnego.

Format odpowiedzi CLI pozostaje zgodny:

```json
{"status":"valid"}
```

Polecenia `skill install`, `skill update`, `skill status` i `skill uninstall` nie zmieniają semantyki.

## Test regresyjny

Test tworzy prawidłowe źródło, instaluje je do tymczasowego workspace i wywołuje publiczną walidację katalogu docelowego. Oczekiwany wynik to `valid`.

Istniejące testy nadal muszą potwierdzać odrzucenie instalacji po zmianie pliku, dodaniu pliku lub użyciu dowiązania symbolicznego. Po teście ukierunkowanym zostanie uruchomiony pełny zestaw testów projektu.
