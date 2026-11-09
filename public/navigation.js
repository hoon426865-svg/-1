export const menuItems = [
  {id:'home',label:'홈',description:'오늘의 현황과 자주 쓰는 기능'},
  {id:'attendance',label:'출퇴근',description:'출근·퇴근 기록 확인'},
  {id:'production',label:'생산 관리',description:'작업과 생산량 관리'},
  {id:'materials',label:'자재 관리',permission:'materials'},
  {id:'quality',label:'품질 관리',permission:'quality'},
  {id:'requests',label:'근무 신청',description:'신청과 처리 이력'},
  {id:'employees',label:'직원 관리',admin:true},
  {id:'reports',label:'통계·보고서',admin:true},
  {id:'settings',label:'설정',description:'계정과 로그인 정보'},
];
const nav = document.querySelector('#app-navigation');
const toggle = document.querySelector('#menu-toggle');
const backdrop = document.querySelector('#menu-backdrop');
let allowed = [], active = 'home', onSelect = () => {};
function closeMenu(returnFocus=false) {
  document.body.classList.remove('menu-open');
  toggle.setAttribute('aria-expanded','false');
  backdrop.hidden = true;
  document.querySelector('main').inert = false;
  if (returnFocus) toggle.focus();
}
function select(focus=false) {
  if (!allowed.length) return;
  const requested = location.hash.slice(1);
  active = allowed.some(item => item.id === requested) ? requested : 'home';
  if (requested !== active) history.replaceState(null,'',location.pathname+location.search+'#'+active);
  for (const panel of document.querySelectorAll('[data-page]')) panel.hidden = panel.dataset.page !== active;
  for (const link of nav.querySelectorAll('a')) {
    if (link.hash === '#'+active) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  closeMenu();
  document.title = `${allowed.find(item => item.id === active).label} · 온워크`;
  onSelect(active);
  if (focus) {
    const heading=document.querySelector(`[data-page="${active}"] h1`);
    heading?.focus({preventScroll:true});
    window.scrollTo({top:0,behavior:'instant'});
  }
}
export function mountNavigation(me, callback=()=>{}) {
  allowed = menuItems.filter(item => (!item.admin || me.role === 'admin') && (!item.permission || me.operations?.[item.permission]));
  onSelect = callback;
  nav.innerHTML = `<p class="nav-caption">업무 메뉴</p>${allowed.map(item => `<a href="#${item.id}"><span>${item.label}</span><span aria-hidden="true">›</span></a>`).join('')}<p class="nav-footnote">${me.role==='admin'?'관리자':'직원'} 화면 · 한국 시간 기준</p>`;
  nav.hidden = false; toggle.hidden = false;
  document.body.classList.add('has-navigation');
  select();
}
export function resetNavigation() {
  allowed=[];onSelect=()=>{};closeMenu();
  nav.replaceChildren();nav.hidden=true;toggle.hidden=true;
  document.body.classList.remove('has-navigation');
  document.title='온워크 · 출퇴근과 생산 기록';
}
toggle.addEventListener('click',()=>{
  const open=toggle.getAttribute('aria-expanded')!=='true';
  document.body.classList.toggle('menu-open',open);
  toggle.setAttribute('aria-expanded',String(open));backdrop.hidden=!open;
  document.querySelector('main').inert=open;
  if(open) nav.querySelector('[aria-current="page"]')?.focus();
});
backdrop.addEventListener('click',()=>closeMenu(true));
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();closeMenu();document.querySelector('#screen').focus();});
nav.addEventListener('click',event=>{if(event.target.closest('a')?.hash==='#'+active) {closeMenu();select(true);}});
window.addEventListener('hashchange',()=>select(true));
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('menu-open'))closeMenu(true);});
window.matchMedia('(min-width: 901px)').addEventListener('change',()=>closeMenu());
