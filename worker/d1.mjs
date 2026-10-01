export const check = (condition,status,message) => {if(!condition)throw Object.assign(Error(message),{status});};
export const statement = (db,sql,args=[]) => db.prepare(sql).bind(...args);
export const one = (db,sql,...args) => statement(db,sql,args).first();
export const all = async (db,sql,...args) => (await statement(db,sql,args).all()).results;

// Count statements, including each statement in a batch, before sending them.
// Queries above the Free invocation budget fail closed rather than retrying or
// moving the same workload to another Worker to evade the platform limit.
export function boundedDatabase(database,limit=50){
  let used=0;const originals=new WeakMap();
  const charge=count=>{check(used+count<=limit,503,'무료 DB 실행 한도에 도달했습니다. 요청 범위를 줄여 주세요.');used+=count;};
  const wrap=original=>{
    const prepared={bind(...args){return wrap(original.bind(...args));}};
    for(const method of ['first','all','run','raw'])prepared[method]=(...args)=>{charge(1);return original[method](...args);};
    originals.set(prepared,original);return prepared;
  };
  return {prepare(sql){return wrap(database.prepare(sql));},batch(statements){charge(statements.length);return database.batch(statements.map(s=>originals.get(s)));},get queryCount(){return used;}};
}

// Reads precede writes. A guarded D1 batch is an optimistic serializable write
// transaction: every business/auth write increments the revision via triggers.
// Conflicting reads abort the entire batch (including history/audit/session).
// No BEGIN/COMMIT or process-local locks: D1 batch provides the atomic boundary.
export async function begin(db) {
  const row=await one(db,'SELECT revision FROM worker_revision WHERE id=1');
  check(row,503,'DB 이전 검증이 필요합니다.');
  const writes=[];
  return {
    revision:row.revision,
    add(sql,...args){writes.push(statement(db,sql,args));},
    async commit(){
      if(!writes.length)return;
      check(writes.length<=40,413,'한 번에 처리할 변경이 너무 많습니다.');
      try {
        await db.batch([
          statement(db,'INSERT INTO worker_guard(id,ok) SELECT 1,revision=? FROM worker_revision WHERE id=1',[row.revision]),
          ...writes,
          statement(db,'DELETE FROM worker_guard WHERE id=1'),
        ]);
      }catch(error){
        if(/worker_guard|CHECK constraint failed: ok/i.test(error.message)) throw Object.assign(Error('다른 변경이 있습니다. 새로고침 후 다시 시도하세요.'),{status:409});
        if(/UNIQUE constraint|FOREIGN KEY constraint|overlap/i.test(error.message)) throw Object.assign(Error('기록이 변경되었거나 중복됩니다. 새로고침해 주세요.'),{status:409});
        throw error;
      }
    },
  };
}
export async function consistent(db,revision) {
  check((await one(db,'SELECT revision FROM worker_revision WHERE id=1'))?.revision===revision,409,'조회 중 변경이 있습니다. 다시 조회하세요.');
}
export function audit(tx,user,action,target,reason,before,after,now) {
  tx.add('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?,?)',crypto.randomUUID(),user.id,user.login,now,action,target,reason,before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after));
}
