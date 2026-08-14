/* Ejecuta TODAS las vistas de Aurova con los datos reales de Jesús.
   Un chequeo de sintaxis no ve un ReferenceError; esto sí. */
const fs=require("fs"), vm=require("vm");
// Corre TODAS las vistas con datos realistas y falla si alguna revienta.
// Existe porque `node --check` valida sintaxis pero no ejecuta nada: una
// variable borrada que sigue usándose pasa el chequeo y deja una pestaña en
// blanco en producción. Eso ya pasó con `totLim` en la pestaña Plan.
//   node tests/render-test.js            → contra el index.html de al lado
//   node tests/render-test.js otro.html  → contra otra copia
const path=require("path");
const P=process.argv[2]||path.join(__dirname,"..","index.html");
const code=fs.readFileSync(P,"utf8").match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];

const noop=()=>{};
const el=()=>({textContent:"",innerHTML:"",value:"",style:{},setAttribute:noop,
  classList:{add:noop,remove:noop,contains:()=>false},querySelectorAll:()=>[],appendChild:noop,
  onclick:null,remove:noop,focus:noop,children:[],dataset:{},getAttribute:()=>null});
const ctx={console,Math,Date,JSON,Intl,Number,String,Array,Object,parseFloat,parseInt,isNaN,
  encodeURIComponent,decodeURIComponent,setTimeout:noop,clearTimeout:noop,setInterval:noop,
  clearInterval:noop,fetch:()=>Promise.resolve({json:()=>({})}),addEventListener:noop,
  removeEventListener:noop,matchMedia:()=>({matches:false,addEventListener:noop}),
  localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
  location:{search:"",href:"",hash:""},navigator:{language:"es",serviceWorker:{register:()=>Promise.resolve()}},
  alert:noop,confirm:()=>true,prompt:()=>null,
  document:{getElementById:el,querySelector:el,querySelectorAll:()=>[],createElement:el,
    body:{classList:{add:noop,remove:noop}},addEventListener:noop,documentElement:{setAttribute:noop}},
  supabase:{createClient:()=>({auth:{getSession:()=>Promise.resolve({data:{}}),onAuthStateChange:noop},
    from:()=>({select:()=>({eq:()=>({maybeSingle:()=>Promise.resolve({})})})}),rpc:()=>Promise.resolve({})})}};
ctx.window=ctx; ctx.globalThis=ctx;
vm.createContext(ctx);

// El setup corre en el MISMO ámbito léxico, así ve el `let state` del archivo.
const setup=`
const _id=n=>(state.categories.find(c=>c.name===n)||{}).id;
state.accounts=[
 {id:"a1",kind:"pasivo",type:"Préstamo personal",name:"Préstamo personal",value:4000,rate:38,payment:164,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a2",kind:"pasivo",type:"Tarjeta de crédito",name:"Capital One Platinum",value:1975.5,rate:29.99,payment:60,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a3",kind:"pasivo",type:"Tarjeta de crédito",name:"Chase",value:5063.01,rate:27.99,payment:162,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a4",kind:"pasivo",type:"Tarjeta de crédito",name:"Capital One Venture",value:2801.36,rate:26.99,payment:94,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a5",kind:"pasivo",type:"Tarjeta de crédito",name:"Bank of America",value:1439.6,rate:24.99,payment:35,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a6",kind:"pasivo",type:"Préstamo de auto",name:"BMW X1",value:37211.4,rate:14,payment:775.78,dueDay:1,limit:0,paid:[],paidLog:[]},
 {id:"a7",kind:"pasivo",type:"Otra deuda",name:"Mamá",value:6790,rate:0,payment:0,dueDay:1,limit:0,paid:[],paidLog:[]}];
state.recurring=[
 {id:"r1",paid:[],type:"ingreso",name:"Wells Fargo",amount:3225,dueDay:1,categoryId:_id("Salario"),freq:"mensual"},
 {id:"r2",paid:[],type:"ingreso",name:"Spark",amount:1733,dueDay:1,categoryId:_id("Spark / Delivery"),freq:"mensual"},
 {id:"r3",paid:[],type:"gasto",name:"Vivienda",amount:850,dueDay:1,categoryId:_id("Renta"),freq:"mensual"},
 {id:"r4",paid:[],type:"gasto",name:"Comida",amount:400,dueDay:1,categoryId:_id("Comida"),freq:"mensual"},
 {id:"r5",paid:[],type:"gasto",name:"Gasolina",amount:360,dueDay:1,categoryId:_id("Transporte"),freq:"mensual"}];
state.budgets={[_id("Renta")]:1000};
state.transactions=[{id:"t1",type:"ingreso",amount:2081.14,categoryId:_id("Spark / Delivery"),date:SEL+"-14",note:"Spark (pago)"}];
state.profile.name="Jesus";

const _res=[];
for(const v of ["viewInicio","viewMovimientos","viewPagos","viewMetas","viewPresupuesto","viewAnalisis"]){
  try{ const o=eval(v)(); if(typeof o!=="string"||!o.length) throw new Error("devolvió vacío");
       _res.push(["ok",v,o.length]); }catch(e){ _res.push(["fail",v,e.message]); }
}
for(const f of ["pintarPlanDeudas","revisarPerfil","revisionInicio"]){
  try{ eval(f)(); _res.push(["ok",f,""]); }catch(e){ _res.push(["fail",f,e.message]); }
}
_res;
`;
let res;
try{ res=vm.runInContext(code+"\n;"+setup, ctx, {timeout:10000}); }
catch(e){ console.log("❌ al cargar:",e.message); process.exit(1); }

let fallos=0;
for(const [st,name,info] of res){
  if(st==="ok") console.log("  ✅",name.padEnd(18), info?String(info).padStart(6)+" caracteres":"");
  else { fallos++; console.log("  ❌",name.padEnd(18), info); }
}
console.log(fallos?`\n❌ ${fallos} roto(s)`:"\n✅ todas las vistas y modales renderizan sin error");
process.exit(fallos?1:0);
