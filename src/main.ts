import './style.css';
import { patchShaderChunks } from './core/shaderPatches';
import { Game } from './game/game';

patchShaderChunks();

const game = new Game();
game.boot().catch((err) => {
  console.error(err);
  const s = document.getElementById('loader-status');
  if (s) s.textContent = 'Something went wrong while building the isle. Try reloading (WebGL2 is required).';
});
(window as unknown as { game: Game }).game = game;
