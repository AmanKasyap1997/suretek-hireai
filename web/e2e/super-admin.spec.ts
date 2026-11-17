import { test, expect } from '@playwright/test';
test('Super Admin console exposes six sections and submits a validated organization',async({page})=>{
 const submissions:unknown[]=[];
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/v1/auth/session')return route.fulfill({json:{user:{id:'owner',tenant_id:'platform',role:'SUPER_ADMIN',full_name:'Platform owner',email:'owner@example.test',active:true,platform_admin:true,organization_name:'Suretek Platform'},expiresAt:Date.now()+900000}});
  if(route.request().method()==='POST'){submissions.push(route.request().postDataJSON());return route.fulfill({json:{id:'created',deliveryStatus:'SENT'}});}
  const data=path.endsWith('/dashboard')?{total_organizations:0,trial:0,active:0,suspended:0,total_users:0,new_this_month:0,integrations_ok:0,integrations_failing:0,attention:[],recent_events:[]}:path.endsWith('/integrations')||path.endsWith('/admins')?[]:path.endsWith('/reports')?{organizations:[],integrations:[]}:path.endsWith('/settings')?{roles:['SUPER_ADMIN','HR_ADMIN'],defaults:{retention_days:365,calling_start:9,calling_end:18,call_quota:1000,emergency_pause:false,password_min_length:12,session_seconds:3600}}:{data:[],pagination:{total:0}};
  return route.fulfill({json:data});
 });
 await page.goto('super-admin/dashboard');
 await expect(page.getByRole('heading',{name:'Platform dashboard'})).toBeVisible();
 await expect(page.getByRole('navigation').getByRole('link')).toHaveCount(6);
 await page.getByRole('link',{name:'Organizations',exact:true}).click();
 await page.getByText('Add organization',{exact:true}).click();
 await page.getByLabel('Name',{exact:true}).fill('Example Company');
 await page.getByLabel('Slug',{exact:true}).fill('example-company');
 await page.getByLabel('First HR Admin name').fill('Organization admin');
 await page.getByLabel('First HR Admin email').fill('admin@example.test');
 await page.getByRole('button',{name:'Create organization & invite admin'}).click();
 await expect(page.getByText('Saved successfully.')).toBeVisible();
 expect(submissions[0]).toMatchObject({name:'Example Company',slug:'example-company',enabled_modules:['hiring','core_hr','leave','attendance','onboarding'],limits:{max_users:100}});
 for(const title of ['Integrations','Settings','Audit Logs','Platform Reports']){
  await page.getByRole('navigation').getByRole('link',{name:title,exact:true}).click();
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
 }
 await page.setViewportSize({width:390,height:844});
 await page.reload();
 await page.getByRole('button',{name:'Toggle navigation'}).click();
 await expect(page.getByRole('navigation')).toBeVisible();
});
