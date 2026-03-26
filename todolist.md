# 📋 Lista Migliorie per Quest Archive

Ecco una lista di potenziali miglioramenti per il progetto, suddivisi per area di intervento.

---

## 🎨 Frontend & UI/UX

- [x] **Rimozione Sistema Categorie**: Eliminata completamente la logica e i filtri relativi alle categorie dal backend e dal frontend.
- [x] **Lazy Loading**: Implementare il caricamento pigro per le immagini per velocizzare il caricamento iniziale della pagina.
- [x] **Feedback Utente**: Migliorare i messaggi di errore e di successo durante i download e gli upload, rendendoli più descrittivi.
- [x] **Dark/Light Mode**: Raffinare il design "glassmorphism" per una coerenza visiva ancora maggiore.

---

## ⚙️ Backend & Architettura

- [x] **Sistema di Autenticazione**: Implementare un sistema di login più robusto con sessioni gestite lato server (es. Redis o DB store).
- [x] **Refactoring Admin**: Spostare utility come la "R2 Migration" in script separati o in una sezione dedicata per pulire la dashboard principale.
- [x] **Documentazione API**: Generare una documentazione Swagger/OpenAPI per rendere le API facilmente consultabili.
- [x] **Logging Avanzato**: Implementare un sistema di logging più granulare per facilitare il debug in produzione.

---

## ☁️ Cloud & Storage (R2)

- [x] **Ottimizzazione Upload**: Gestire meglio gli upload interrotti con possibilità di ripresa (resumable uploads).
- [x] **Asset Management**: Automatizzare completamente il caricamento delle immagini su GitHub o R2 direttamente dall'interfaccia admin.
- [x] **Caching**: Configurare header di cache più aggressivi per le risorse statiche servite tramite Cloudflare.

---

## 🛠️ Manutenibilità & Test

- [ ] **Test Automatizzati**: Scrivere test unitari per le rotte API e test d'integrazione per il flusso di download/upload.
- [ ] **CI/CD**: Configurare una pipeline di Continuous Integration per eseguire i test a ogni commit.
- [x] **Standardizzazione Codice**: Introdurre ESLint e Prettier per mantenere uno stile di codice uniforme nel progetto.
