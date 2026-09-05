/* Executes against the actual application in an isolated browser. */
window.runPredictionTests = async function () {
  const results = [];
  function assert(value, message) { if(!value) throw new Error(message); }
  async function test(name, body) {
    try { await body(); results.push({name, passed:true}); }
    catch(error) { results.push({name, passed:false, error:String(error.stack || error)}); }
  }
  const code='1-WW-FR-008-0003-000';
  function events(values=[7.2,6.9,6.6], extra={}) {
    userDB.events = values.map((thickness,i) => ({code, date:`${2022+i}-01-01`, type:'检测', desc:'实测', thickness, hardness:180-i*5, spec:'Φ63.5×7.5', material:'SA-210C', pipeType:'straight', ...extra}));
    userDB.replacements=[];
  }
  const history=()=>extractThicknessData(code,{includeSystem:false});
  const model=(pipeType='straight')=>predictThicknessTrendFromHistory(code,history(),pipeType);
  await test('full script loads without syntax/runtime errors',()=>assert(!window.__testErrors.length,JSON.stringify(window.__testErrors)));
  await test('44 library rows provide nominal and theory fields',()=>{
    const lib=getMaterialLibrary(); assert(lib.length===44,`rows ${lib.length}`);
    assert(lib.every(r=>r.theoryMatched && r.straight>0 && r.nominalWall>0),'missing material theory');
    assert(lib.filter(r=>r.bend===null).length===2,'unavailable bend values must be null');
  });
  await test('straight and outer bend use different material thresholds',()=>{
    events(); const a=model(),b=model('bend');
    assert(a.threshold===6.49 && b.threshold===5.92,'incorrect thresholds');
    assert(a.thresholdInfo.nominalWall===7.5,'nominal wall');
    assert(a.replacementWarning.level==='replace-soon','near straight warning');
    assert(b.replacementWarning.level==='normal','bend margin should be above 0.2mm');
  });
  await test('0.2mm inclusive boundary and measured threshold crossing',()=>{
    const info=resolveMaterialTheoryThickness(code,'straight');
    for(const [value,level] of [[6.48,'replace'],[6.49,'replace'],[6.69,'replace-soon'],[6.691,'normal']]) {
      assert(assessReplacementWarning(value,info).level===level,`boundary ${value}`);
    }
    for(const value of [null,undefined,'',NaN]) assert(assessReplacementWarning(value,info).level==='unknown','invalid reading warning');
  });
  await test('single point below threshold alerts without inventing RUL',()=>{
    events([6.4]); const d=model(); renderAIResults(d);
    assert(d.rul===null && d.replacementWarning.level==='replace' && d.prediction.length===0,'single-point result');
    assert(document.getElementById('ai-status').textContent.includes('更换预警'),'warning suppressed by low quality');
    assert(document.querySelectorAll('#aiChart circle').length>0,'single-point plot');
  });
  await test('empty records do not report replacement or leave stale graphs',()=>{
    events([]); const d=model(); renderAIResults(d);
    assert(d.replacementWarning.level==='unknown' && d.rul===null && d.prediction.length===0,'empty state');
    assert(document.getElementById('hardnessChart').textContent.includes('暂无'),'stale hardness');
    assert(document.getElementById('aiChart').textContent.includes('暂无'),'stale thickness');
  });
  await test('wrong material and nominal wall never use broad component fallback',()=>{
    for(const extra of [{material:'UNKNOWN'},{spec:'Φ63.5×6'},{spec:'Φ63.5×7.5、Φ159×18'},{material:'SA-210C/20G'}]) {
      events([7.2,6.9,6.6],extra); const d=model(); renderAIResults(d);
      assert(d.threshold===null && d.rul===null && d.prediction.length===0,'unsafe fallback '+JSON.stringify(extra));
      assert(document.getElementById('aiChart').textContent.includes('仅展示实测历史'),'history-only state');
      assert(!/NaN|Infinity/.test(document.getElementById('aiChart').innerHTML),'invalid chart coordinates');
    }
  });
  await test('unavailable bend threshold and invalid pipeType remain unknown',()=>{
    events([5,4.8,4.6],{code:'1-LSH-E-001-0001-000',spec:'Φ60×8.5',material:'15CrMoG'});
    const target=userDB.events[0].code, h=extractThicknessData(target,{includeSystem:false});
    const d=predictThicknessTrendFromHistory(target,h,'bend');
    assert(d.threshold===null && d.thresholdInfo.straight===4.16 && d.thresholdInfo.bend===null && d.rul===null,'missing bend became a number');
    events(); assert(model('invalid').threshold===null,'invalid type silently defaults');
  });
  await test('latest dated tube metadata wins over insertion order',()=>{
    events(); userDB.events.push({code,date:'2019-01-01',spec:'Φ99×9',material:'UNKNOWN'});
    assert(model().threshold===6.49,'uses last insertion rather than latest date');
  });
  await test('three scenarios and hardness forecasts remain available',()=>{
    events([7.5,7.2,7.0]); const d=model(); renderAIResults(d);
    assert(d.reliable===true && d.quality.score>=55,'quality');
    assert(d.prediction.length>2 && d.prediction.every(p=>p.low<=p.val && p.val<=p.high),'prediction band');
    assert(Number(d.acceleratedThresholdYear)<=Number(d.baselineThresholdYear),'scenario ordering');
    assert(d.compositeSignals.hardnessForecast.oneYear===165 && d.compositeSignals.hardnessForecast.threeYear===155,'hardness regression');
    const circles=[...document.querySelectorAll('#hardnessChart circle')];
    assert(circles.every(c=>Number(c.getAttribute('cx'))<=952),'hardness future outside viewport');
  });
  await test('detail entry automatically calls model and renders both charts',async()=>{
    events(); openTubeProfile(code);
    assert(window.__activeTubeAnalysis.target===code,'detail did not invoke model');
    assert(document.getElementById('ai-results').style.display==='block','results hidden');
    assert(document.querySelectorAll('#aiChart path').length>=2,'thickness paths');
    assert(document.querySelectorAll('#hardnessChart path').length>=2,'hardness paths');
    assert(document.getElementById('searchResult').textContent.includes('名义壁厚'),'detail threshold labels');
    assert(document.getElementById('ai-replacement-warning').textContent.includes('更换预警'),'warning panel');
  });
  await test('pipe selector recalculates and updates detail and results together',async()=>{
    await changeAnalysisPipeType('bend');
    assert(window.__activeTubeAnalysis.threshold===5.92,'analysis type not updated');
    assert(document.getElementById('searchResult').textContent.includes('弯管外侧 5.92'),'detail stale threshold');
    assert(document.getElementById('ai-threshold-detail').textContent.includes('5.92'),'result stale threshold');
  });
  await test('lifecycle and exact search entries also invoke model for one point',()=>{
    events([6.4]); window.__tubePipeTypes={}; loadLifecycle(code);
    assert(window.__activeTubeAnalysis.history.length===1,'lifecycle no single-point analysis');
    document.getElementById('lcCustomCode').value=code; doSearch();
    assert(window.__activeTubeAnalysis.replacementWarning.level==='replace','exact search missing warning');
  });
  await test('no remote model requests when unconfigured',()=>assert(window.__externalRequests.length===0,JSON.stringify(window.__externalRequests)));
  await test('configured model is invoked and stale response cannot overwrite new tube',async()=>{
    const originalConfig=getLLMConfig, originalCall=callLLMChatCompletions;
    const requests=[];
    getLLMConfig=()=>({baseUrl:'mock',apiKey:'test',model:'test'});
    callLLMChatCompletions=()=>new Promise(resolve=>requests.push(resolve));
    try {
      events(); const a=runAIAnalysis(code,'straight'),b=runAIAnalysis(code,'bend');
      assert(requests.length===2,'configured model not called');
      requests[1]('new bend report'); await b; requests[0]('stale straight report'); await a;
      assert(document.getElementById('ai-llm-report').textContent==='new bend report','stale report overwrote latest');
    } finally { getLLMConfig=originalConfig; callLLMChatCompletions=originalCall; }
  });
  await test('dashboard uses measured replacement warnings even without warning words',()=>{
    events([6.4]); const item=collectDashboardWarnings({limit:100}).find(item=>item.code===code);
    assert(item?.level==='HIGH' && item.text.includes('立即更换预警'),'dashboard misses numeric warning');
    events([6.69]); assert(collectDashboardWarnings({limit:100}).some(item=>item.code===code && item.text.includes('提前更换预警')),'dashboard misses near threshold');
  });
  await test('missing tube identity cannot select first broad component row',()=>{
    userDB.events=[{code:'1-HSH-O-001-0001-000',date:'2024-01-01',thickness:5.7,type:'测厚',desc:'实测'}];
    const info=resolveMaterialTheoryThickness(userDB.events[0].code,'straight');
    assert(info.threshold===null && info.rule===false,'ambiguous component chose first record');
  });
  await test('full script remains error-free after all workflows',()=>assert(window.__testErrors.length===0,JSON.stringify(window.__testErrors)));
  events(); window.__tubePipeTypes={}; openTubeProfile(code);
  const resultsPanel=document.getElementById('ai-results');
  resultsPanel.scrollIntoView({block:'start'});
  return {passed:results.every(r=>r.passed),results,errors:window.__testErrors};
};
