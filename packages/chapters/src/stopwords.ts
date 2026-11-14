/**
 * Stopwords per language for lexical cohesion. Spoken transcripts are full of
 * fillers ("gonna", "yeah", "kind of"), so the English list includes them.
 * Languages without a list still work: the segmenter also drops terms that
 * appear in most of the transcript, which catches each language's function
 * words from the data itself.
 */

const EN = `a about above after again against all almost also although always am among an and another any anybody anyone
anything anyway are aren around as at back be became because become been before being below between both but by can
cannot can't could couldn't did didn't do does doesn't doing don't done down during each either else enough even ever
every everybody everyone everything few for from further get gets getting go goes going gone gonna good got gotta had
hadn't has hasn't have haven't having he he'd he'll her here here's hers herself he's him himself his how however i i'd
if i'll i'm in into is isn't it its it's itself i've just kind know let let's like little lot lots made make makes
making many maybe me might mine more most much must my myself need needs never new no nobody none nor not nothing now
of off oh ok okay on once one only or other others our ours ourselves out over own pretty probably put quite rather
really right said same say saying says see seen she she'd she'll she's should shouldn't so some somebody someone
something sort still stuff such sure take than thank thanks that that's the their theirs them themselves then there
there's these they they'd they'll they're they've thing things think this those though through to too toward actually
um uh under until up upon us use used using very want wanna was wasn't way we we'd well we'll were we're weren't we've
what what's when where where's whether which while who who's whom whose why will with within without won't would
wouldn't yeah yes yet you you'd you'll your you're yours yourself yourselves you've basically literally obviously
anyways alright gotten mean means look looking looks come comes coming came went goes talk talking guys guy also
okay hey hmm mhm`;

const DE = `aber alle allem allen aller alles als also am an ander andere anderen auch auf aus bei beim bin bis bist da dabei
dadurch dafür dagegen daher damit dann darauf darum das dass dein deine dem den denn der des deshalb dich die dies diese
diesem diesen dieser dieses doch dort du durch ein eine einem einen einer eines einfach er es etwas euch euer für gar
gegen genau gibt habe haben hat hatte hier ich ihm ihn ihr ihre im immer in ist ja jetzt kann kein keine können man
mehr mein meine mich mir mit muss nach nicht nichts noch nun nur ob oder ohne schon sehr sein seine sich sie sind so
solche soll sondern sonst über um und uns unser unter viel vom von vor war waren warum was weil weiter welche wenn
wer werden wie wieder wir wird wo würde zu zum zur zwar zwischen also halt eben mal okay naja`;

const ES = `a al algo algunos ante antes aquí así aun aunque bien cada como con contra cual cuando de del desde donde dos el
ella ellas ellos en entre era es esa ese eso esta este esto estos está están fue ha hace hacer hay he la las le les lo
los más me mi mientras mismo muy nada ni no nos nosotros o otra otro para pero poco por porque pues que qué se sea ser
si sí sin sobre solo son su sus también tan te tener tiene todo todos tu tú un una uno unos usted vamos y ya yo bueno
entonces vale`;

const FR = `à ai aie alors au aucun aussi autre aux avec avoir bon car ce cela ces cet cette ceux chaque comme comment dans de
des donc dont du elle elles en encore est et été être eu fait faire ici il ils je juste la le les leur lui ma mais me
même mes moi mon ne ni nos notre nous on ou où par parce pas peu peut plus pour pourquoi quand que quel quelle qui sa
sans se ses si son sont sur ta te tes toi ton tous tout très tu un une vos votre vous voilà y ça euh bah ben quoi`;

const PT = `a ao aos aquela aquele as até com como da das de dela dele do dos e ela ele eles em entre era essa esse esta este
eu foi há isso isto já la lá mais mas me mesmo meu minha muito na nas não nem no nos nós o os ou para pela pelo por
porque quando que quem se sem ser seu sua são também te tem tu tudo um uma você vocês né então tipo`;

const LISTS: Record<string, string> = { en: EN, de: DE, es: ES, fr: FR, pt: PT };

const cache = new Map<string, Set<string>>();

/** The stopword set for a BCP-47 language (by primary subtag), or an empty set when there is no list. */
export function stopwordsFor(language: string | undefined): Set<string> {
  const key = (language ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = LISTS[key];
  const set = new Set(raw ? raw.split(/\s+/).filter(Boolean) : []);
  cache.set(key, set);
  return set;
}

/** Languages with a built-in stopword list. */
export const STOPWORD_LANGUAGES = Object.keys(LISTS);
