import { createRoot } from "react-dom/client";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import "./site.css";

const windowsDownloadPath = "/downloads/Scenario-Setup-0.1.6.exe";
const macDownloadPath = "/downloads/Scenario-macOS-0.1.6.zip";

function MacDownload({ compact = false }: { compact?: boolean }) {
  return (
    <Dialog>
      <DialogTrigger className={`download${compact ? " compact" : ""}`}>
        Télécharger <span>macOS</span>{!compact && <b>→</b>}
      </DialogTrigger>
      <DialogContent className="mac-dialog" showCloseButton={false}>
        <DialogTitle className="mac-dialog-title">Avant d’installer sur macOS</DialogTitle>
        <DialogDescription className="mac-dialog-description">
          Téléchargez le fichier, puis suivez bien les instructions d’installation fournies avec la version macOS.
        </DialogDescription>
        <div className="mac-dialog-actions">
          <DialogClose className="mac-cancel">Annuler</DialogClose>
          <a className="download" href={macDownloadPath} download>
            Télécharger pour macOS <b>→</b>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function App() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#accueil" aria-label="Scénario, accueil">
          <img src="/scenario-logo.png" alt="" />
          <span>Scénario</span>
        </a>
      </header>

      <section className="hero" id="accueil">
        <div className="hero-copy">
          <p className="eyebrow">LOGICIEL D’ÉCRITURE DE SCÉNARIO</p>
          <h1>Écrire sans détour.</h1>
          <p className="lead">
            Scénario réunit l’essentiel pour écrire, mettre en page et terminer un scénario sans se perdre dans les réglages.
          </p>
          <div className="hero-actions">
            <a className="download" href={windowsDownloadPath} download>Télécharger pour Windows <b>→</b></a>
            <MacDownload />
            <span>Version 0.1.6 · Windows et macOS</span>
          </div>
        </div>
        <div className="hero-mark" aria-hidden="true">
          <div className="paper">
            <div className="fold" />
            <img src="/scenario-logo.png" alt="" />
            <i /><i /><i />
          </div>
        </div>
      </section>

      <section className="features" aria-label="Fonctionnalités">
        <article>
          <span>01</span>
          <h2>La bonne mise en page, dès la première ligne.</h2>
          <p>Scènes, actions, dialogues et transitions se mettent naturellement à leur place. La pagination suit l’écriture.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Écrire vite, rester concentré.</h2>
          <p>Tab, aide à l’écriture, raccourcis personnels et navigation simple : moins de manipulations, plus de texte.</p>
        </article>
        <article>
          <span>03</span>
          <h2>Une IA, seulement quand elle est utile.</h2>
          <p>Survolez une action ou un dialogue pour le corriger, le traduire ou le raccourcir. Vos consignes personnalisées restent à portée de clic.</p>
        </article>
        <article>
          <span>04</span>
          <h2>Un scénario prêt à partager.</h2>
          <p>Page de garde, numéros de scènes, commentaires, export PDF et traduction sont là lorsque vous en avez besoin.</p>
        </article>
      </section>

      <footer>Scénario · Un logiciel d’écriture de scénario pour Windows et macOS</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
