# BRA-4 — lokalny kandydat UI + security

## Pochodzenie i zakres

- Baza security/dependencies: `d97c4364e6cef3f89434de252199bbb90e1de033`.
- Źródło projektu UI: `fa3268c6a01863c733c76fc4273d392fbfaaac6e` (BRA-2 / PR #3).
- Gałąź kandydata: `integration/bra-4-ui-security`.
- Konflikt `src/app/page.tsx` rozwiązano, zachowując tworzenie pokoju przez `POST /api/rooms`, token w sessionStorage, walidację 16-znakowych ID i istniejących 4-cyfrowych pokojów oraz stan oczekiwania/wyłączony przycisk.
- Nowy formularz zachowuje etykietę, `aria-invalid`, komunikat `role="alert"` i obsługę Enter. Pole przyjmuje do 16 znaków, bez wymuszania klawiatury numerycznej ani automatycznej kapitalizacji.
- W pokoju zachowano walidację ID, wysyłanie tokenu przy join, usunięcie tokenu po `room-info` i limit długości hasła.
- Backend, migracje, helpery/testy security i zależności są niezmienione względem bazy `d97c436`.
- BRA-3 pozostaje historycznym werdyktem QA wariantu czterocyfrowego, nie akceptacją tego nowego połączenia.

## Weryfikacja lokalna — 2026-10-02 America/New_York

Świeży izolowany worktree, własne node_modules i katalog .next; bez dev/watchera i bez zmian wspólnego środowiska.

| Polecenie | Wynik |
| --- | --- |
| `npm ci --no-audit --no-fund` | EXIT 0, 262 pakiety |
| `npm test` | EXIT 0, istniejące testy security 5/5 PASS |
| `./node_modules/.bin/tsc --noEmit --incremental false` | EXIT 0 |
| `npm run build` | EXIT 0, Next.js 15.5.27; `/` i `/room` wygenerowane statycznie |
| `git diff --cached --check` | EXIT 0 |

Istniejące pięć testów sprawdza helpery ID, tokenów i haseł. Nie stanowią dowodu end-to-end dla HTTP, Socket.IO, migracji ani interfejsu.

## Następny odcinek QA

Testować dokładny commit kandydata w izolowanym środowisku aplikacji i PostgreSQL, ze zgodną bazą procesu oraz odczytów testowych:

1. Utworzenie nowego pokoju przez API, 16-znakowe ID, jednokrotne przejęcie tokenem; odrzucenie braku/błędnego tokenu.
2. Join istniejącego pokoju legacy 4 oraz nowego 16; odrzucenie nieprawidłowego ID i błędnego hasła.
3. Potwierdzenie ograniczania prób create/join, dostarczenia wiadomości i poprawnego odczytu bazy.
4. Formularze i nagłówek z długim ID na 320/390 px oraz 699/700/701 px; klawiatura/fokus, DM/pliki w zakresie zleconego testu.

Migracje, ustawienia proxy i konfiguracja integracji API wymagają oddzielnego przygotowania środowiska. Nie zmieniano bazy, nie uruchamiano serwera i nie wykonano migracji. Historyczne zrzuty BRA-2 nie są dowodem działania tego kandydata. Brak push, merge i deploy w tym odcinku.
